// macOS framework edge only. Lifecycle, recovery policy and IPC remain TypeScript.
#import <AVFoundation/AVFoundation.h>
#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

@interface OWFailingInput : NSObject
@end
@implementation OWFailingInput
- (AVAudioFormat *)inputFormatForBus:(AVAudioNodeBus)__unused bus {
    return [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:48000 channels:1 interleaved:NO];
}
- (void)installTapOnBus:(AVAudioNodeBus)__unused bus bufferSize:(AVAudioFrameCount)__unused size
                format:(AVAudioFormat *)__unused format block:(AVAudioNodeTapBlock)__unused block {
    [NSException raise:@"OwnedSyntheticCapture" format:@"Synthetic failure"];
}
- (void)removeTapOnBus:(AVAudioNodeBus)__unused bus {
    [NSException raise:@"OwnedSyntheticCapture" format:@"Synthetic failure"];
}
@end
@interface OWFailingEngine : NSObject
@property(nonatomic) BOOL stopAttempted;
@property(nonatomic) BOOL raiseStop;
- (AVAudioInputNode *)inputNode;
- (void)stop;
@end
@implementation OWFailingEngine
- (AVAudioInputNode *)inputNode { return (AVAudioInputNode *)[[OWFailingInput alloc] init]; }
- (void)stop {
    self.stopAttempted = YES;
    if (self.raiseStop) [NSException raise:@"OwnedSyntheticCapture" format:@"Synthetic failure"];
}
@end

std::vector<float> wf_macos_reference(const std::vector<AVAudioPCMBuffer *> & input);
namespace {
constexpr size_t block_samples = 16384;
constexpr double max_safe = 9007199254740991.0;
const napi_type_tag tag = {0x45a1a172ab8ed912ULL, 0x711e9c193374f50bULL};
struct Piece { AVAudioPCMBuffer * __strong buffer; };
struct Session;
using Shared = std::shared_ptr<Session>;
struct Session {
    const double generation;
    const bool synthetic;
    std::atomic<bool> busy{false}, running{false}, closed{false}, failed{false}, released{false}, cancelled{false};
    std::atomic<bool> fail_next_queue{false};
    std::atomic<uint64_t> frames{0}, sequence{0};
    std::atomic<uint32_t> rate, channels;
    std::atomic<float> level{0};
    std::mutex mutex;
    std::condition_variable condition;
    bool accepting = false, held = false, fail_next_copy = false;
    uint32_t active = 0;
    const char * reason = "none"; // Fixed literals; failure latching cannot allocate.
    std::vector<Piece> raw;
    std::vector<std::vector<float>> prepared, reference;
    AVAudioEngine * __strong engine = nil;
    id __strong observer = nil;
    std::atomic<uint32_t> engine_allocations{0}, input_operations{0}, permission_queries{0};
    dispatch_queue_t control = dispatch_queue_create("io.github.whisperfree.dev.capture", DISPATCH_QUEUE_SERIAL);
    Shared backend_owner; // A callback can never become the last owner of a live engine.
    Session(double g, bool s, uint32_t r, uint32_t c) : generation(g), synthetic(s), rate(r), channels(c) {
        if (!control) throw std::bad_alloc();
    }
    void fail(const char * code) noexcept {
        failed = true;
        // Called with the ledger lock held, except after capture has been fenced.
        if (std::strcmp(reason, "none") == 0) reason = code;
    }
    ~Session() {
        @autoreleasepool {
            @try { if (observer) [[NSNotificationCenter defaultCenter] removeObserver:observer]; } @catch (NSException * __unused exception) {}
            @try { if (engine) [engine.inputNode removeTapOnBus:0]; } @catch (NSException * __unused exception) {}
            @try { if (engine) [engine stop]; } @catch (NSException * __unused exception) {}
        }
    }
};

bool stop_engine(id engine) noexcept {
    bool stopped = true;
    @try { [[engine inputNode] removeTapOnBus:0]; } @catch (NSException * __unused exception) { stopped = false; }
    @try { [engine stop]; } @catch (NSException * __unused exception) { stopped = false; }
    return stopped;
}
bool open_engine(id engine, AVAudioNodeTapBlock tap) noexcept {
    @try {
        AVAudioInputNode * input = [engine inputNode]; AVAudioFormat * format = [input inputFormatForBus:0];
        if (!std::isfinite(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192000
            || format.channelCount == 0 || format.channelCount > 8 || format.commonFormat != AVAudioPCMFormatFloat32) return false;
        [input installTapOnBus:0 bufferSize:1024 format:nil block:tap];
        [engine prepare]; NSError * error = nil;
        return [engine startAndReturnError:&error];
    } @catch (NSException * __unused exception) { return false; }
}

void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("CAPTURE_FAILED"); }
napi_value object(napi_env e) { napi_value v; check(napi_create_object(e, &v)); return v; }
napi_value undefined(napi_env e) { napi_value v; check(napi_get_undefined(e, &v)); return v; }
napi_value boolean(napi_env e, bool b) { napi_value v; check(napi_get_boolean(e, b, &v)); return v; }
napi_value number(napi_env e, double n) { napi_value v; check(napi_create_double(e, n, &v)); return v; }
napi_value text(napi_env e, const std::string & s) { napi_value v; check(napi_create_string_utf8(e, s.data(), s.size(), &v)); return v; }
void set(napi_env e, napi_value v, const char * name, napi_value x) { check(napi_set_named_property(e, v, name, x)); }
std::vector<napi_value> arguments(napi_env e, napi_callback_info info, size_t count) {
    size_t actual = count + 1; std::vector<napi_value> values(actual);
    check(napi_get_cb_info(e, info, &actual, values.data(), nullptr, nullptr));
    if (actual != count) throw std::runtime_error("CAPTURE_FAILED");
    values.resize(count); return values;
}
double integer(napi_env e, napi_value v, double minimum, double maximum) {
    double n; check(napi_get_value_double(e, v, &n));
    if (!std::isfinite(n) || std::floor(n) != n || n < minimum || n > maximum) throw std::runtime_error("CAPTURE_FAILED");
    return n;
}
Shared owner(napi_env e, napi_value v) {
    bool valid = false; check(napi_check_object_type_tag(e, v, &tag, &valid));
    void * data = nullptr; if (!valid) throw std::runtime_error("CAPTURE_FAILED");
    check(napi_unwrap(e, v, &data)); if (!data) throw std::runtime_error("CAPTURE_FAILED");
    return *static_cast<Shared *>(data);
}
napi_value failure(napi_env e) noexcept { napi_throw_error(e, "CAPTURE_FAILED", "The native capture operation failed."); return nullptr; }
napi_value metadata(napi_env e, const Shared & s) {
    std::lock_guard<std::mutex> lock(s->mutex);
    napi_value value = object(e);
    set(e, value, "generation", number(e, s->generation)); set(e, value, "running", boolean(e, s->running));
    set(e, value, "streamClosed", boolean(e, s->closed)); set(e, value, "finalSamplesFenced", boolean(e, s->closed));
    set(e, value, "failed", boolean(e, s->failed)); set(e, value, "failureKind", text(e, s->reason));
    set(e, value, "frameCount", text(e, std::to_string(s->frames.load()))); set(e, value, "sequence", text(e, std::to_string(s->sequence.load())));
    set(e, value, "sampleRate", number(e, s->rate)); set(e, value, "channels", number(e, s->channels)); set(e, value, "level", number(e, s->level));
    return value;
}
AVAudioPCMBuffer * pcm(const float * samples, size_t count, uint32_t rate, uint32_t channels, bool interleaved) {
    if (!samples || count == 0 || count % channels || count / channels > UINT32_MAX) throw std::runtime_error("CAPTURE_FAILED");
    AVAudioFormat * format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:rate channels:channels interleaved:interleaved];
    AVAudioPCMBuffer * buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:AVAudioFrameCount(count / channels)];
    if (!buffer) throw std::runtime_error("CAPTURE_FAILED"); buffer.frameLength = AVAudioFrameCount(count / channels);
    if (interleaved) std::memcpy(buffer.floatChannelData[0], samples, count * sizeof(float));
    else for (size_t frame = 0; frame < count / channels; frame++) for (uint32_t channel = 0; channel < channels; channel++) {
        buffer.floatChannelData[channel][frame] = samples[frame * channels + channel];
    }
    return buffer;
}
void append(const Shared & s, AVAudioPCMBuffer * buffer) noexcept {
    @autoreleasepool {
        std::unique_lock<std::mutex> lock(s->mutex);
        if (!s->accepting || s->released || s->cancelled) return;
        s->active++;
        // Synthetic latch models a callback already accepted before Stop's fence.
        s->condition.notify_all(); s->condition.wait(lock, [&] { return !s->held; });
        @try {
            try {
                if (s->fail_next_copy) { s->fail_next_copy = false; throw std::bad_alloc(); }
                const auto rate = buffer.format.sampleRate;
                const auto channels = buffer.format.channelCount;
                if (buffer.frameLength == 0 || !std::isfinite(rate) || rate < 8000 || rate > 192000 || channels == 0 || channels > 8
                    || buffer.format.commonFormat != AVAudioPCMFormatFloat32 || !buffer.floatChannelData) throw std::runtime_error("CAPTURE_FAILED");
                AVAudioPCMBuffer * copy = [[AVAudioPCMBuffer alloc] initWithPCMFormat:buffer.format frameCapacity:buffer.frameLength];
                if (!copy) throw std::bad_alloc(); copy.frameLength = buffer.frameLength;
                const AudioBufferList * input = buffer.audioBufferList;
                AudioBufferList * output = copy.mutableAudioBufferList;
                if (input->mNumberBuffers != output->mNumberBuffers) throw std::runtime_error("CAPTURE_FAILED");
                float peak = 0;
                for (UInt32 index = 0; index < input->mNumberBuffers; index++) {
                    const AudioBuffer & piece = input->mBuffers[index];
                    const size_t bytes = size_t(buffer.frameLength) * piece.mNumberChannels * sizeof(float);
                    if (!piece.mData || piece.mDataByteSize < bytes || output->mBuffers[index].mDataByteSize < bytes) throw std::runtime_error("CAPTURE_FAILED");
                    const float * samples = static_cast<const float *>(piece.mData);
                    for (size_t i = 0; i < bytes / sizeof(float); i++) {
                        if (!std::isfinite(samples[i])) throw std::runtime_error("CAPTURE_FAILED");
                        peak = std::max(peak, std::abs(samples[i]));
                    }
                    std::memcpy(output->mBuffers[index].mData, piece.mData, bytes);
                }
                if (UINT64_MAX - s->frames < buffer.frameLength) throw std::runtime_error("CAPTURE_FAILED");
                s->raw.push_back({ copy }); s->frames += buffer.frameLength; s->sequence++;
                s->rate = uint32_t(rate); s->channels = channels; s->level = std::min(peak, 1.0f);
            } catch (const std::bad_alloc &) { s->fail("allocation"); }
            catch (...) { s->fail("format"); }
        } @catch (NSException * __unused exception) { s->fail("backend"); }
        s->active--; s->condition.notify_all();
    }
}
void start(const Shared & s) {
    if (s->closed || s->released || s->running || s->cancelled) throw std::runtime_error("CAPTURE_FAILED");
    if (s->synthetic) { std::lock_guard<std::mutex> lock(s->mutex); s->accepting = true; s->running = true; return; }
    @autoreleasepool {
        @try {
            s->permission_queries++;
            if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) throw std::runtime_error("CAPTURE_FAILED");
            if (s->cancelled) throw std::runtime_error("CAPTURE_FAILED");
            s->backend_owner = s;
            s->engine_allocations++; s->engine = [[AVAudioEngine alloc] init];
            if (!s->engine) throw std::bad_alloc();
            std::weak_ptr<Session> weak = s;
            s->observer = [[NSNotificationCenter defaultCenter] addObserverForName:AVAudioEngineConfigurationChangeNotification object:s->engine queue:nil usingBlock:^(NSNotification * __unused notification) {
                if (const auto current = weak.lock()) {
                    std::lock_guard<std::mutex> lock(current->mutex);
                    if (current->running && !current->closed) current->fail("interrupted");
                }
            }];
            s->input_operations++;
            { std::lock_guard<std::mutex> lock(s->mutex); s->accepting = true; }
            if (s->cancelled) throw std::runtime_error("CAPTURE_FAILED");
            const bool started = open_engine(s->engine, ^(AVAudioPCMBuffer * buffer, AVAudioTime * __unused time) {
                if (const auto current = weak.lock()) append(current, buffer);
            });
            if (s->cancelled || !started) throw std::runtime_error("CAPTURE_FAILED");
            s->running = true;
        } @catch (NSException * __unused exception) { throw std::runtime_error("CAPTURE_FAILED"); }
    }
}
void close(const Shared & s) {
    if (s->released || s->closed) return;
    if (s->engine) {
        @autoreleasepool {
            // Preserve an interruption already visible before intentional shutdown.
            @try { if (s->running && !s->engine.isRunning) { std::lock_guard<std::mutex> lock(s->mutex); s->fail("terminal"); } }
            @catch (NSException * __unused exception) { std::lock_guard<std::mutex> lock(s->mutex); s->fail("backend"); }
            s->input_operations++;
            if (!stop_engine(s->engine)) { std::lock_guard<std::mutex> lock(s->mutex); s->fail("backend"); }
            // An exception must never turn an unconfirmed live stream into a closed receipt.
            // Retain this engine/owner for explicit cleanup retry or utility termination.
            bool confirmed = false;
            @try { confirmed = !s->engine.isRunning; } @catch (NSException * __unused exception) {}
            if (!confirmed) {
                std::lock_guard<std::mutex> lock(s->mutex); s->accepting = false; s->fail("backend");
                throw std::runtime_error("CAPTURE_FAILED");
            }
        }
    }
    std::unique_lock<std::mutex> lock(s->mutex); s->accepting = false; s->running = false;
    if (!s->condition.wait_for(lock, std::chrono::seconds(10), [&] { return s->active == 0; })) throw std::runtime_error("CAPTURE_FAILED");
    if (s->observer) [[NSNotificationCenter defaultCenter] removeObserver:s->observer];
    s->observer = nil; s->engine = nil; s->closed = true; s->backend_owner.reset();
}
void collect(std::vector<std::vector<float>> & target, AVAudioPCMBuffer * output) {
    if (output.frameLength == 0) return;
    const float * samples = output.floatChannelData[0];
    for (size_t offset = 0; offset < output.frameLength; offset += block_samples) {
        const size_t count = std::min(block_samples, size_t(output.frameLength) - offset);
        for (size_t i = 0; i < count; i++) if (!std::isfinite(samples[offset + i])) throw std::runtime_error("CAPTURE_FAILED");
        target.emplace_back(samples + offset, samples + offset + count);
    }
}
AVAudioPCMBuffer * slice_buffer(AVAudioPCMBuffer * source, size_t offset, size_t frames) {
    AVAudioPCMBuffer * output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:source.format frameCapacity:AVAudioFrameCount(frames)];
    if (!output) throw std::bad_alloc(); output.frameLength = AVAudioFrameCount(frames);
    const auto input = source.audioBufferList; const auto destination = output.mutableAudioBufferList;
    for (UInt32 index = 0; index < input->mNumberBuffers; index++) {
        const size_t stride = input->mBuffers[index].mNumberChannels * sizeof(float);
        std::memcpy(destination->mBuffers[index].mData, static_cast<char *>(input->mBuffers[index].mData) + offset * stride, frames * stride);
    }
    return output;
}
void convert_group(const std::vector<Piece> & input, size_t begin, size_t end, std::vector<std::vector<float>> & result) {
    AVAudioFormat * format = input.at(begin).buffer.format;
    AVAudioFormat * target = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
    AVAudioConverter * converter = [[AVAudioConverter alloc] initFromFormat:format toFormat:target];
    if (!converter) throw std::runtime_error("CAPTURE_FAILED");
    std::vector<Piece> blocks(input.begin() + begin, input.begin() + end);
    __block size_t cursor = 0, input_offset = 0;
    __block bool input_error = false;
    __block bool sent_end = false;
    size_t no_progress = 0;
    for (;;) {
        AVAudioPCMBuffer * output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:target frameCapacity:AVAudioFrameCount(block_samples)];
        if (!output) throw std::bad_alloc(); NSError * error = nil;
        const size_t before = cursor, before_offset = input_offset;
        const AVAudioConverterOutputStatus status = [converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer * (AVAudioPacketCount packets, AVAudioConverterInputStatus * state) {
            @try { try {
                if (cursor < blocks.size() && packets > 0) {
                    AVAudioPCMBuffer * source = blocks[cursor].buffer;
                    const size_t frames = std::min(size_t(packets), size_t(source.frameLength) - input_offset);
                    AVAudioPCMBuffer * piece = slice_buffer(source, input_offset, frames);
                    input_offset += frames;
                    if (input_offset == source.frameLength) { input_offset = 0; cursor++; }
                    *state = AVAudioConverterInputStatus_HaveData; return piece;
                }
            } catch (...) { input_error = true; } }
            @catch (NSException * __unused exception) { input_error = true; }
            if (input_error || (cursor < blocks.size() && packets == 0)) {
                input_error = true; *state = AVAudioConverterInputStatus_NoDataNow; return nil;
            }
            sent_end = true; *state = AVAudioConverterInputStatus_EndOfStream; return nil;
        }];
        if (status == AVAudioConverterOutputStatus_Error || error || input_error) throw std::runtime_error("CAPTURE_FAILED");
        collect(result, output);
        if (status == AVAudioConverterOutputStatus_EndOfStream) break;
        if (before == cursor && before_offset == input_offset && output.frameLength == 0) { if (++no_progress > 16) throw std::runtime_error("CAPTURE_FAILED"); }
        else no_progress = 0;
    }
    if (!sent_end || cursor != blocks.size()) throw std::runtime_error("CAPTURE_FAILED");
}
void prepare(const Shared & s, bool reference) {
    if (!s->closed || s->released || (reference && !s->synthetic)) throw std::runtime_error("CAPTURE_FAILED");
    @autoreleasepool {
        @try {
            std::vector<std::vector<float>> result;
            for (size_t begin = 0; begin < s->raw.size();) {
                size_t end = begin + 1;
                while (end < s->raw.size() && [s->raw[begin].buffer.format isEqual:s->raw[end].buffer.format]) end++;
                if (reference) {
                    std::vector<AVAudioPCMBuffer *> buffers;
                    for (size_t i = begin; i < end; i++) buffers.push_back(s->raw[i].buffer);
                    const auto output = wf_macos_reference(buffers);
                    for (size_t offset = 0; offset < output.size(); offset += block_samples) {
                        const auto count = std::min(block_samples, output.size() - offset);
                        result.emplace_back(output.begin() + offset, output.begin() + offset + count);
                    }
                } else convert_group(s->raw, begin, end, result);
                begin = end;
            }
            (reference ? s->reference : s->prepared) = std::move(result);
        } @catch (NSException * __unused exception) { throw std::runtime_error("CAPTURE_FAILED"); }
    }
}
struct Work {
    napi_env env = nullptr; napi_deferred deferred = nullptr; napi_async_work work = nullptr; Shared session; std::string operation;
    std::vector<float> samples; uint32_t rate = 0, channels = 0; bool interleaved = false; bool rejected = false;
};
void execute(napi_env, void * data) {
    Work * job = static_cast<Work *>(data); const Shared s = job->session;
    const auto operation = ^{ @autoreleasepool {
        @try {
            try {
                if (job->operation == "start") start(s);
                else if (job->operation == "close") close(s);
                else if (job->operation == "prepare" || job->operation == "reference") prepare(s, job->operation == "reference");
                else if (job->operation == "feed") append(s, pcm(job->samples.data(), job->samples.size(), job->rate, job->channels, job->interleaved));
                else if (job->operation == "release") { close(s); s->raw.clear(); s->prepared.clear(); s->reference.clear(); s->released = true; }
            } catch (...) {
                job->rejected = true;
                if (job->operation == "start") { { std::lock_guard<std::mutex> lock(s->mutex); s->fail("start"); } try { close(s); } catch (...) {} }
            }
        } @catch (NSException * __unused exception) { job->rejected = true; }
    } };
    if (job->operation == "feed") operation(); else dispatch_sync(s->control, operation);
}
void complete(napi_env env, napi_status status, void * data) {
    std::unique_ptr<Work> job(static_cast<Work *>(data));
    if (job->operation != "feed") job->session->busy = false;
    try {
        if (status != napi_ok || job->rejected) {
            napi_value message = text(env, "The native capture operation failed."), error;
            check(napi_create_error(env, text(env, "CAPTURE_FAILED"), message, &error)); check(napi_reject_deferred(env, job->deferred, error));
        } else {
            napi_value value = metadata(env, job->session);
            if (job->operation == "prepare" || job->operation == "reference") {
                const auto & chunks = job->operation == "prepare" ? job->session->prepared : job->session->reference;
                uint64_t samples = 0; for (const auto & chunk : chunks) samples += chunk.size();
                if (samples > uint64_t(max_safe)) throw std::runtime_error("CAPTURE_FAILED");
                set(env, value, "sampleCount", number(env, double(samples))); set(env, value, "chunkCount", number(env, double(chunks.size())));
            }
            check(napi_resolve_deferred(env, job->deferred, value));
        }
    } catch (...) { failure(env); }
    napi_delete_async_work(env, job->work);
}
napi_value queue(napi_env env, Shared s, const char * operation, std::vector<float> samples = {}, uint32_t rate = 0, uint32_t channels = 0, bool interleaved = false) {
    const bool feed = std::strcmp(operation, "feed") == 0;
    if (!feed && s->busy.exchange(true)) throw std::runtime_error("CAPTURE_FAILED");
    std::unique_ptr<Work> job;
    napi_value promise;
    try {
        if (s->synthetic && s->fail_next_queue.exchange(false)) throw std::bad_alloc();
        job = std::make_unique<Work>(); job->env = env; job->session = s; job->operation = operation;
        job->samples = std::move(samples); job->rate = rate; job->channels = channels; job->interleaved = interleaved;
        check(napi_create_promise(env, &job->deferred, &promise));
        check(napi_create_async_work(env, nullptr, text(env, "OpenWhisperMacCapture"), execute, complete, job.get(), &job->work));
        check(napi_queue_async_work(env, job->work)); job.release(); return promise;
    } catch (...) { if (job && job->work) napi_delete_async_work(env, job->work); if (!feed) s->busy = false; throw; }
}
napi_value create(napi_env env, napi_callback_info info) {
    try {
        const auto a = arguments(env, info, 4); bool synthetic; check(napi_get_value_bool(env, a[1], &synthetic));
        auto s = std::make_shared<Session>(integer(env, a[0], 1, max_safe), synthetic,
            uint32_t(integer(env, a[2], 8000, 192000)), uint32_t(integer(env, a[3], 1, 8)));
        napi_value value = object(env); auto holder = std::make_unique<Shared>(s);
        check(napi_wrap(env, value, holder.get(), [](napi_env, void * pointer, void *) { delete static_cast<Shared *>(pointer); }, nullptr, nullptr));
        holder.release(); check(napi_type_tag_object(env, value, &tag)); return value;
    } catch (...) { return failure(env); }
}
#define OPERATION(name, op) napi_value name(napi_env env, napi_callback_info info) { try { const auto a = arguments(env, info, 1); return queue(env, owner(env, a[0]), op); } catch (...) { return failure(env); } }
OPERATION(start_js, "start") OPERATION(close_js, "close") OPERATION(prepare_js, "prepare") OPERATION(release_js, "release") OPERATION(reference_js, "reference")
napi_value status_js(napi_env env, napi_callback_info info) { try { const auto a = arguments(env, info, 1); return metadata(env, owner(env, a[0])); } catch (...) { return failure(env); } }
napi_value diagnostics_js(napi_env env, napi_callback_info info) {
    try { const auto a = arguments(env, info, 1); const auto s = owner(env, a[0]); std::lock_guard<std::mutex> lock(s->mutex); napi_value v = object(env);
        set(env, v, "engineAllocations", number(env, s->engine_allocations)); set(env, v, "inputNodeOperations", number(env, s->input_operations));
        set(env, v, "permissionQueries", number(env, s->permission_queries)); set(env, v, "permissionRequests", number(env, 0)); set(env, v, "diskOperations", number(env, 0));
        set(env, v, "activeCallbacks", number(env, s->active)); set(env, v, "released", boolean(env, s->released)); return v;
    } catch (...) { return failure(env); }
}
std::vector<float> samples(napi_env env, napi_value value) {
    napi_typedarray_type type; size_t count; void * data; napi_value buffer; size_t offset;
    check(napi_get_typedarray_info(env, value, &type, &count, &data, &buffer, &offset));
    if (type != napi_float32_array || count == 0 || count > 192000 * 8 || !data) throw std::runtime_error("CAPTURE_FAILED");
    auto result = std::vector<float>(static_cast<float *>(data), static_cast<float *>(data) + count);
    for (float x : result) if (!std::isfinite(x)) throw std::runtime_error("CAPTURE_FAILED"); return result;
}
napi_value feed_js(napi_env env, napi_callback_info info) {
    try { const auto a = arguments(env, info, 5); const auto s = owner(env, a[0]); bool interleaved; check(napi_get_value_bool(env, a[4], &interleaved));
        if (!s->synthetic) throw std::runtime_error("CAPTURE_FAILED"); return queue(env, s, "feed", samples(env, a[1]),
            uint32_t(integer(env, a[2], 8000, 192000)), uint32_t(integer(env, a[3], 1, 8)), interleaved);
    } catch (...) { return failure(env); }
}
napi_value feed_sync_js(napi_env env, napi_callback_info info) {
    try { const auto a = arguments(env, info, 5); const auto s = owner(env, a[0]); bool interleaved; check(napi_get_value_bool(env, a[4], &interleaved));
        { std::lock_guard<std::mutex> lock(s->mutex); if (!s->synthetic || s->held) throw std::runtime_error("CAPTURE_FAILED"); }
        const auto input = samples(env, a[1]);
        @autoreleasepool { @try { append(s, pcm(input.data(), input.size(), uint32_t(integer(env, a[2], 8000, 192000)),
            uint32_t(integer(env, a[3], 1, 8)), interleaved)); }
            @catch (NSException * __unused exception) { return failure(env); } }
        return undefined(env);
    } catch (...) { return failure(env); }
}
napi_value hook_js(napi_env env, napi_callback_info info) {
    try { const auto a = arguments(env, info, 3); const auto s = owner(env, a[0]); const int action = int(integer(env, a[1], 0, 4)); bool enabled; check(napi_get_value_bool(env, a[2], &enabled));
        if (!s->synthetic) throw std::runtime_error("CAPTURE_FAILED"); std::lock_guard<std::mutex> lock(s->mutex);
        if (action == 0) { s->held = enabled; s->condition.notify_all(); }
        else if (action == 1) s->fail_next_copy = enabled;
        else if (action == 2) s->fail("interrupted");
        else if (action == 3) { s->cancelled = true; s->accepting = false; s->held = false; s->condition.notify_all(); }
        else s->fail_next_queue = enabled;
        return undefined(env);
    } catch (...) { return failure(env); }
}
napi_value abort_js(napi_env env, napi_callback_info info) {
    try { const auto a = arguments(env, info, 1); const auto s = owner(env, a[0]); std::lock_guard<std::mutex> lock(s->mutex);
        s->cancelled = true; s->accepting = false; s->held = false; s->condition.notify_all(); return undefined(env);
    } catch (...) { return failure(env); }
}
napi_value read_js(napi_env env, napi_callback_info info) {
    try { const auto a = arguments(env, info, 3); const auto s = owner(env, a[0]); bool reference; check(napi_get_value_bool(env, a[2], &reference));
        if (!s->closed || s->busy || s->released || (reference && !s->synthetic)) throw std::runtime_error("CAPTURE_FAILED");
        const auto & input = (reference ? s->reference : s->prepared).at(size_t(integer(env, a[1], 0, max_safe)));
        void * output; napi_value buffer, value; check(napi_create_arraybuffer(env, input.size() * sizeof(float), &output, &buffer));
        std::memcpy(output, input.data(), input.size() * sizeof(float)); check(napi_create_typedarray(env, napi_float32_array, input.size(), buffer, 0, &value)); return value;
    } catch (...) { return failure(env); }
}
napi_value exceptions_js(napi_env env, napi_callback_info info) {
    try { (void)arguments(env, info, 0);
        @autoreleasepool {
            OWFailingEngine * engine = [[OWFailingEngine alloc] init];
            const bool started = open_engine(engine, ^(AVAudioPCMBuffer * __unused buffer, AVAudioTime * __unused time) {});
            const bool stopped = stop_engine(engine);
            OWFailingEngine * raising = [[OWFailingEngine alloc] init]; raising.raiseStop = YES;
            const bool raising_stopped = stop_engine(raising);
            napi_value value = object(env);
            set(env, value, "startExceptionContained", boolean(env, !started)); set(env, value, "stopExceptionContained", boolean(env, !stopped));
            set(env, value, "stopAttemptedAfterRemovalException", boolean(env, engine.stopAttempted));
            set(env, value, "engineStopExceptionContained", boolean(env, !raising_stopped && raising.stopAttempted)); return value;
        }
    } catch (...) { return failure(env); }
}
napi_value initialize(napi_env env, napi_value exports) {
    const napi_property_descriptor descriptors[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"start", nullptr, start_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"closeAndFence", nullptr, close_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"prepare", nullptr, prepare_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"release", nullptr, release_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"status", nullptr, status_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"diagnostics", nullptr, diagnostics_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"feedFormat", nullptr, feed_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"feedSync", nullptr, feed_sync_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"abortStart", nullptr, abort_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"hook", nullptr, hook_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"reference", nullptr, reference_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"readChunk", nullptr, read_js, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"exceptionProbe", nullptr, exceptions_js, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    if (napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors) != napi_ok) return failure(env);
    return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
