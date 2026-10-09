// Minimal session-owned capture/conversion boundary. Policy and recovery remain TypeScript.
#include <node_api.h>
#include "miniaudio.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <dlfcn.h>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

extern "C" void wf_capture_install_read_guard(ma_device* device);
extern "C" int wf_capture_visit_fragment(const void * input, size_t bytes, ma_format format, ma_uint32 channels,
                                         void * owner, void (*consume)(void *, const void *, ma_uint32));

namespace {
constexpr size_t chunk_frames = 16384;
constexpr double maximum_safe_integer = 9007199254740991.0;
const napi_type_tag session_tag = {0x815afd9dba597a35ULL, 0xa87575e7de9118cdULL};
enum class Failure { none, start, source, terminal, backend, peek, hole, format, drop, invalid, allocation, cancelled, injected, suspended, rerouted, interrupted };
const char * failure_names[] = {"none", "start", "source", "terminal", "backend", "peek", "hole", "format", "drop", "invalid", "allocation", "cancelled", "injected", "suspended", "rerouted", "interrupted"};
struct Session {
    const double generation;
    const bool synthetic;
    std::atomic<bool> busy{false}, running{false}, expected_stop{true}, closed{false};
    std::atomic<bool> failed{false}, released{false}, source_failed{false}, start_cancelled{false};
    std::atomic<uint64_t> frames{0}, sequence{0}, output_count{0};
    std::atomic<uint32_t> rate, channels;
    std::atomic<float> level{0};
    std::atomic<Failure> failure_kind{Failure::none};
    std::mutex samples_mutex;
    std::vector<std::vector<float>> raw;
    std::vector<std::shared_ptr<std::vector<float>>> prepared;
    ma_context context{};
    ma_device device{};
    ma_log log{};
    std::string selected_source;
    bool context_initialized = false, device_initialized = false, log_initialized = false;

    Session(double g, bool s, uint32_t r, uint32_t c) : generation(g), synthetic(s), rate(r), channels(c) {}
    ~Session() { cleanup(); }
    void fail(Failure reason, bool block = false) noexcept {
        Failure empty = Failure::none;
        failure_kind.compare_exchange_strong(empty, reason);
        failed = true;
        if (block) source_failed = true;
    }
    void cleanup() noexcept {
        expected_stop = true;
        if (device_initialized) { ma_device_uninit(&device); device_initialized = false; }
        if (context_initialized) { ma_context_uninit(&context); context_initialized = false; }
        if (log_initialized) { ma_log_uninit(&log); log_initialized = false; }
        running = false;
    }
    void append(const float * input, size_t count) noexcept {
        try {
            std::lock_guard<std::mutex> lock(samples_mutex);
            if (closed || released || !running || source_failed || start_cancelled) return;
            if (count == 0) return;
            const auto c = channels.load();
            if (!input || c == 0 || count % c || count / c > UINT64_MAX - frames.load()) {
                fail(Failure::invalid);
                return;
            }
            raw.emplace_back(input, input + count);
            float peak = 0;
            for (size_t i = 0; i < count; i++) {
                if (!std::isfinite(input[i])) fail(Failure::invalid);
                else peak = std::max(peak, std::abs(input[i]));
            }
            frames += count / c;
            sequence++;
            // No user data leaves the callback; only a bounded meter value is observed.
            level = std::min(1.0f, peak);
        } catch (...) { fail(Failure::allocation); }
    }
};
using Shared = std::shared_ptr<Session>;
void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("CAPTURE_FAILED"); }
napi_value object(napi_env env) { napi_value v; check(napi_create_object(env, &v)); return v; }
napi_value nothing(napi_env env) { napi_value v; check(napi_get_undefined(env, &v)); return v; }
napi_value number(napi_env env, double n) { napi_value v; check(napi_create_double(env, n, &v)); return v; }
napi_value boolean(napi_env env, bool b) { napi_value v; check(napi_get_boolean(env, b, &v)); return v; }
napi_value text(napi_env env, const std::string & s) {
    napi_value v; check(napi_create_string_utf8(env, s.c_str(), s.size(), &v)); return v;
}
void set(napi_env env, napi_value v, const char * key, napi_value value) {
    check(napi_set_named_property(env, v, key, value));
}
std::vector<napi_value> args(napi_env env, napi_callback_info info, size_t count) {
    size_t actual = count + 1;
    std::vector<napi_value> values(actual);
    check(napi_get_cb_info(env, info, &actual, values.data(), nullptr, nullptr));
    if (actual != count) throw std::runtime_error("CAPTURE_FAILED");
    values.resize(count); return values;
}
double integer(napi_env env, napi_value v, double min, double max) {
    double n; check(napi_get_value_double(env, v, &n));
    if (!std::isfinite(n) || std::floor(n) != n || n < min || n > max)
        throw std::runtime_error("CAPTURE_FAILED");
    return n;
}
std::string string(napi_env env, napi_value v, size_t maximum) {
    size_t size; check(napi_get_value_string_utf8(env, v, nullptr, 0, &size));
    if (size == 0 || size > maximum) throw std::runtime_error("CAPTURE_FAILED");
    std::vector<char> bytes(size + 1);
    check(napi_get_value_string_utf8(env, v, bytes.data(), bytes.size(), &size));
    std::string result(bytes.data(), size);
    if (result.find('\0') != std::string::npos) throw std::runtime_error("CAPTURE_FAILED");
    return result;
}
Shared owner(napi_env env, napi_value v) {
    bool valid = false; check(napi_check_object_type_tag(env, v, &session_tag, &valid));
    if (!valid) throw std::runtime_error("CAPTURE_FAILED");
    void * data; check(napi_unwrap(env, v, &data));
    if (!data) throw std::runtime_error("CAPTURE_FAILED");
    return *static_cast<Shared *>(data);
}
napi_value failure(napi_env env) noexcept {
    napi_throw_error(env, "CAPTURE_FAILED", "The native capture operation failed."); return nullptr;
}
struct SourceInfo { std::string id, name; bool is_default; };
struct SourceWork {
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    std::string server;
    std::vector<SourceInfo> sources;
    bool failed = false;
};
struct SourceContext {
    ma_context context{};
    ma_log log{};
    bool initialized = false, log_initialized = false;
    ~SourceContext() {
        if (initialized) ma_context_uninit(&context);
        if (log_initialized) ma_log_uninit(&log);
    }
};
void quiet_source_log(void *, ma_uint32, const char *) {} // Device names/server diagnostics never leave enumeration.
bool valid_source_server(const std::string & server) {
    if (server.compare(0, 6, "unix:/") != 0 || server.size() > 4096 || getuid() == 0) return false;
    // Pulse accepts server lists; only a single explicit owned local socket is permitted.
    if (server.find_first_of(",;{}") != std::string::npos ||
        std::any_of(server.begin(), server.end(), [](unsigned char c) { return c <= 32 || c == 127; })) return false;
    const std::string path = server.substr(5);
    if (path.find("//") != std::string::npos || path.find("/../") != std::string::npos ||
        path.find("/./") != std::string::npos || path.back() == '/' ||
        (path.size() >= 3 && path.compare(path.size() - 3, 3, "/..") == 0) ||
        (path.size() >= 2 && path.compare(path.size() - 2, 2, "/.") == 0)) return false;
    struct stat info{};
    return lstat(path.c_str(), &info) == 0 && S_ISSOCK(info.st_mode) && info.st_uid == getuid();
}
ma_bool32 source_callback(ma_context *, ma_device_type type, const ma_device_info * info, void * data) noexcept {
    auto & w = *static_cast<SourceWork *>(data);
    if (type != ma_device_type_capture) return MA_TRUE;
    try {
        // Pinned miniaudio: source name is the concrete ID; description/default index are metadata.
        // Stop at the first excess source rather than building an unbounded context device array.
        const size_t id_length = strnlen(info->id.pulse, sizeof(info->id.pulse));
        const size_t name_length = strnlen(info->name, sizeof(info->name));
        if (w.sources.size() >= 128 || id_length == 0 || id_length > 255 || name_length > 255)
            throw std::runtime_error("CAPTURE_SOURCE_FAILED");
        w.sources.push_back({std::string(info->id.pulse, id_length), std::string(info->name, name_length), info->isDefault != MA_FALSE});
        return MA_TRUE;
    } catch (...) { w.failed = true; return MA_FALSE; }
}
void enumerate_sources(napi_env, void * data) noexcept {
    auto & w = *static_cast<SourceWork *>(data);
    try {
        if (!valid_source_server(w.server)) throw std::runtime_error("CAPTURE_SOURCE_FAILED");
        SourceContext owned;
        if (ma_log_init(nullptr, &owned.log) != MA_SUCCESS) throw std::runtime_error("CAPTURE_SOURCE_FAILED");
        owned.log_initialized = true;
        if (ma_log_register_callback(&owned.log, ma_log_callback_init(quiet_source_log, nullptr)) != MA_SUCCESS)
            throw std::runtime_error("CAPTURE_SOURCE_FAILED");
        ma_context_config config = ma_context_config_init();
        config.pLog = &owned.log;
        config.pulse.pApplicationName = "OpenWhisper Dev Sources";
        config.pulse.pServerName = w.server.c_str();
        config.pulse.tryAutoSpawn = MA_FALSE;
        const ma_backend backend = ma_backend_pulseaudio;
        if (ma_context_init(&backend, 1, &config, &owned.context) != MA_SUCCESS)
            throw std::runtime_error("CAPTURE_SOURCE_FAILED");
        owned.initialized = true;
        w.sources.reserve(128);
        if (ma_context_enumerate_devices(&owned.context, source_callback, &w) != MA_SUCCESS || w.failed)
            throw std::runtime_error("CAPTURE_SOURCE_FAILED");
        // No device/stream is initialized. Metadata is copied before the owned context closes.
    } catch (...) { w.failed = true; }
}
void complete_sources(napi_env env, napi_status status, void * data) noexcept {
    std::unique_ptr<SourceWork> w(static_cast<SourceWork *>(data));
    try {
        if (w->failed || status != napi_ok) {
            napi_value error;
            check(napi_create_error(env, text(env, "CAPTURE_SOURCE_FAILED"), text(env, "The capture sources are unavailable."), &error));
            check(napi_reject_deferred(env, w->deferred, error));
        } else {
            napi_value list; check(napi_create_array_with_length(env, w->sources.size(), &list));
            for (size_t index = 0; index < w->sources.size(); index++) {
                const auto & source = w->sources[index]; napi_value value = object(env);
                set(env, value, "id", text(env, source.id)); set(env, value, "name", text(env, source.name));
                set(env, value, "isDefault", boolean(env, source.is_default));
                check(napi_set_element(env, list, uint32_t(index), value));
            }
            check(napi_resolve_deferred(env, w->deferred, list));
        }
    } catch (...) { napi_fatal_error("capture", NAPI_AUTO_LENGTH, "Invalid source completion.", NAPI_AUTO_LENGTH); }
    napi_delete_async_work(env, w->work);
}
napi_value enumerate_call(napi_env env, napi_callback_info info) noexcept {
    std::unique_ptr<SourceWork> w;
    try {
        w = std::make_unique<SourceWork>();
        w->server = string(env, args(env, info, 1)[0], 4096);
        napi_value promise; check(napi_create_promise(env, &w->deferred, &promise));
        check(napi_create_async_work(env, nullptr, text(env, "OpenWhisperSources"), enumerate_sources, complete_sources, w.get(), &w->work));
        check(napi_queue_async_work(env, w->work)); w.release(); return promise;
    } catch (...) {
        if (w && w->work) napi_delete_async_work(env, w->work);
        napi_throw_error(env, "CAPTURE_SOURCE_FAILED", "The capture sources are unavailable."); return nullptr;
    }
}
napi_value metadata(napi_env env, const Shared & s) {
    napi_value v = object(env);
    set(env, v, "generation", number(env, s->generation));
    set(env, v, "running", boolean(env, s->running));
    set(env, v, "streamClosed", boolean(env, s->closed));
    set(env, v, "finalSamplesFenced", boolean(env, s->closed));
    set(env, v, "failed", boolean(env, s->failed));
    set(env, v, "failureKind", text(env, failure_names[static_cast<size_t>(s->failure_kind.load())]));
    set(env, v, "frameCount", text(env, std::to_string(s->frames.load())));
    set(env, v, "sequence", text(env, std::to_string(s->sequence.load())));
    set(env, v, "sampleRate", number(env, s->rate));
    set(env, v, "channels", number(env, s->channels));
    set(env, v, "level", number(env, s->level));
    return v;
}
void callback(ma_device * device, void *, const void * input, ma_uint32 frames) {
    auto & s = *static_cast<Session *>(device->pUserData);
    // Called on the device's owning Pulse loop. Never accept data from a changed/default source.
    using GetName = const char * (*)(const void *);
    const auto get_name = reinterpret_cast<GetName>(s.context.pulse.pa_stream_get_device_name);
    const char * name = get_name(device->pulse.pStreamCapture);
    if (!name || s.selected_source != name) { s.fail(Failure::source, true); return; }
    s.append(static_cast<const float *>(input), size_t(frames) * s.channels.load());
}
void pulse_state(void * stream, void * data) {
    auto & s = *static_cast<Session *>(data);
    using GetState = int (*)(const void *);
    const auto state = reinterpret_cast<GetState>(s.context.pulse.pa_stream_get_state)(stream);
    // PA_STREAM_FAILED=3, TERMINATED=4 in the pinned Pulse declarations. No vendor patch is applied.
    if (!s.expected_stop && (state == 3 || state == 4)) s.fail(Failure::terminal, true);
}
void notification(const ma_device_notification * event) {
    auto & s = *static_cast<Session *>(event->pDevice->pUserData);
    if (event->type == ma_device_notification_type_stopped && !s.expected_stop) s.fail(Failure::suspended, true);
    if (event->type == ma_device_notification_type_rerouted) s.fail(Failure::rerouted, true);
    if (event->type == ma_device_notification_type_interruption_began) s.fail(Failure::interrupted, true);
}
void quiet_log(void * data, ma_uint32 level, const char *) {
    auto & s = *static_cast<Session *>(data);
    // Synchronous ma_device_stop can return MA_SUCCESS even when its worker's cork fails.
    // Retain categorical backend errors through Stop; intentional cleanup never logs message text.
    if (level == MA_LOG_LEVEL_ERROR && s.running) s.fail(Failure::backend);
}
void start(const Shared & s, const std::string & source, const std::string & server) {
    if (s->closed || s->released || s->running || s->start_cancelled) throw std::runtime_error("CAPTURE_FAILED");
    if (s->synthetic) { s->running = true; s->expected_stop = false; return; }
    try {
        if (ma_log_init(nullptr, &s->log) != MA_SUCCESS) throw std::runtime_error("CAPTURE_FAILED");
        s->log_initialized = true;
        if (ma_log_register_callback(&s->log, ma_log_callback_init(quiet_log, s.get())) != MA_SUCCESS)
            throw std::runtime_error("CAPTURE_FAILED");
        ma_context_config config = ma_context_config_init();
        config.pLog = &s->log;
        config.pulse.pApplicationName = "OpenWhisper Dev Capture";
        config.pulse.pServerName = server.c_str();
        config.pulse.tryAutoSpawn = MA_FALSE;
        const ma_backend backend = ma_backend_pulseaudio;
        if (ma_context_init(&backend, 1, &config, &s->context) != MA_SUCCESS)
            throw std::runtime_error("CAPTURE_FAILED");
        s->context_initialized = true;
        ma_device_info * inputs = nullptr; ma_uint32 count = 0;
        if (ma_context_get_devices(&s->context, nullptr, nullptr, &inputs, &count) != MA_SUCCESS)
            throw std::runtime_error("CAPTURE_FAILED");
        ma_device_id selected{}; bool found = false;
        for (ma_uint32 i = 0; i < count; i++) {
            if (source == inputs[i].id.pulse) { selected = inputs[i].id; found = true; break; }
        }
        if (!found) throw std::runtime_error("CAPTURE_FAILED");
        if (s->start_cancelled) throw std::runtime_error("CAPTURE_FAILED");
        s->selected_source = source;
        ma_device_config device = ma_device_config_init(ma_device_type_capture);
        device.capture.pDeviceID = &selected;
        device.capture.format = ma_format_f32;
        device.capture.channels = 0;
        device.sampleRate = 0;
        device.noFixedSizedCallback = MA_TRUE;
        device.dataCallback = callback; device.notificationCallback = notification;
        device.pUserData = s.get(); device.pulse.pStreamNameCapture = "OpenWhisper Dev Capture";
        if (ma_device_init(&s->context, &device, &s->device) != MA_SUCCESS)
            throw std::runtime_error("CAPTURE_FAILED");
        s->device_initialized = true;
        s->rate = s->device.sampleRate; s->channels = s->device.capture.channels;
        if (s->rate < 8000 || s->rate > 192000 || s->channels == 0 || s->channels > 8) throw std::runtime_error("CAPTURE_FAILED");
        // Explicit source selects PA_STREAM_DONT_MOVE at upstream miniaudio.h:32094-32098.
        // Register missing terminal-state notifications via libpulse's stable public callback API.
        using SetStateCallback = void (*)(void *, void (*)(void *, void *), void *);
        const auto set_state = reinterpret_cast<SetStateCallback>(dlsym(s->context.pulse.pulseSO, "pa_stream_set_state_callback"));
        if (!set_state || s->start_cancelled) throw std::runtime_error("CAPTURE_FAILED");
        // Pinned miniaudio uses a plain pa_mainloop, not pa_threaded_mainloop.
        // Install both callbacks before ma_device_start begins iterating its capture data loop.
        set_state(s->device.pulse.pStreamCapture, pulse_state, s.get());
        wf_capture_install_read_guard(&s->device);
        s->running = true; s->expected_stop = false;
        if (ma_device_start(&s->device) != MA_SUCCESS || s->failed || s->start_cancelled) throw std::runtime_error("CAPTURE_FAILED");
    } catch (...) { s->fail(s->start_cancelled ? Failure::cancelled : Failure::start); s->cleanup(); throw; }
}
void close(const Shared & s) {
    if (s->released) throw std::runtime_error("CAPTURE_FAILED");
    if (s->closed) return;
    s->expected_stop = true;
    if (s->device_initialized && ma_device_stop(&s->device) != MA_SUCCESS) s->fail(Failure::backend);
    if (s->device_initialized) {
        // Stop's event fence leaves the pinned plain main loop idle before uninit intentionally
        // disconnects it. Cached getters do not open/query another source or block on a server.
        using GetState = int (*)(const void *);
        using GetName = const char * (*)(const void *);
        const int state = reinterpret_cast<GetState>(s->context.pulse.pa_stream_get_state)(s->device.pulse.pStreamCapture);
        const int context_state = reinterpret_cast<GetState>(s->context.pulse.pa_context_get_state)(s->device.pulse.pPulseContext);
        if (state == 3 || state == 4) s->fail(Failure::terminal, true);
        else if (state != 2 || context_state != 4) s->fail(Failure::backend, true);
        else {
            const char * source = reinterpret_cast<GetName>(s->context.pulse.pa_stream_get_device_name)(s->device.pulse.pStreamCapture);
            if (!source || s->selected_source != source) s->fail(Failure::source, true);
        }
    }
    // uninit joins backend activity. No sample lock is held while stop/join can wait for a callback.
    s->cleanup();
    std::lock_guard<std::mutex> lock(s->samples_mutex);
    s->closed = true;
    s->level = 0;
}
void prepare(const Shared & s) {
    if (!s->closed || s->released) throw std::runtime_error("CAPTURE_FAILED");
    const uint64_t frames = s->frames;
    const uint32_t rate = s->rate, channels = s->channels;
    // Exact floor-rounded duration without multiplication overflow.
    if (frames / rate > uint64_t(maximum_safe_integer) / 16000) throw std::runtime_error("CAPTURE_FAILED");
    const uint64_t expected = (frames / rate) * 16000 + ((frames % rate) * 16000) / rate;
    if (expected > uint64_t(maximum_safe_integer)) throw std::runtime_error("CAPTURE_FAILED");
    ma_data_converter_config config = ma_data_converter_config_init(ma_format_f32, ma_format_f32,
                                                                    1, 1, rate, 16000);
    config.resampling.linear.lpfOrder = 8;
    ma_data_converter converter{};
    if (ma_data_converter_init(&config, nullptr, &converter) != MA_SUCCESS)
        throw std::runtime_error("CAPTURE_FAILED");
    struct Guard { ma_data_converter * converter; ~Guard() { ma_data_converter_uninit(converter, nullptr); } } guard{&converter};
    uint64_t skip = ma_data_converter_get_output_latency(&converter), total = 0;
    std::vector<std::shared_ptr<std::vector<float>>> output;
    auto append = [&](const std::vector<float> & block, size_t written) {
        const size_t skipped = size_t(std::min<uint64_t>(skip, written)); skip -= skipped;
        const size_t kept = size_t(std::min<uint64_t>(written - skipped, expected - total));
        if (kept) {
            output.push_back(std::make_shared<std::vector<float>>(block.begin() + skipped, block.begin() + skipped + kept));
            total += kept;
        }
    };
    std::vector<float> block(chunk_frames), mono(chunk_frames);
    for (const auto & chunk : s->raw) {
        if (chunk.size() % channels) throw std::runtime_error("CAPTURE_FAILED");
        uint64_t offset = 0, count = chunk.size() / channels;
        while (offset < count) {
            const size_t mixed = size_t(std::min<uint64_t>(mono.size(), count - offset));
            for (size_t frame = 0; frame < mixed; frame++) {
                double sum = 0;
                for (uint32_t channel = 0; channel < channels; channel++) {
                    const float sample = chunk[(offset + frame) * channels + channel];
                    if (!std::isfinite(sample)) throw std::runtime_error("CAPTURE_FAILED");
                    sum += sample;
                }
                mono[frame] = float(sum / channels);
            }
            size_t position = 0;
            while (position < mixed) {
                ma_uint64 consumed = mixed - position, written = block.size();
                if (ma_data_converter_process_pcm_frames(&converter, mono.data() + position,
                        &consumed, block.data(), &written) != MA_SUCCESS || (!consumed && !written))
                    throw std::runtime_error("CAPTURE_FAILED");
                position += size_t(consumed); append(block, size_t(written));
            }
            offset += mixed;
        }
    }
    // Null input flushes the converter's final cached samples/latency; it never shortens the ledger.
    while (total < expected) {
        ma_uint64 written = std::min<uint64_t>(block.size(), expected - total + skip);
        ma_uint64 zeros = (written * rate) / 16000 + 64;
        if (ma_data_converter_process_pcm_frames(&converter, nullptr, &zeros, block.data(), &written) != MA_SUCCESS || !written)
            throw std::runtime_error("CAPTURE_FAILED");
        append(block, size_t(written));
    }
    s->prepared = std::move(output); s->output_count = total;
}
enum class Operation { start, close, prepare, release };
struct Work {
    napi_env env; napi_async_work work{}; napi_deferred deferred{};
    Shared session; Operation operation; std::string source, server;
    bool failed = false;
};
void execute(napi_env, void * data) noexcept {
    auto & w = *static_cast<Work *>(data);
    try {
        switch (w.operation) {
            case Operation::start: start(w.session, w.source, w.server); break;
            case Operation::close: close(w.session); break;
            case Operation::prepare: prepare(w.session); break;
            case Operation::release:
                close(w.session);
                w.session->raw.clear(); w.session->prepared.clear(); w.session->released = true;
                break;
        }
    } catch (...) { w.failed = true; }
}
void complete(napi_env env, napi_status status, void * data) noexcept {
    std::unique_ptr<Work> w(static_cast<Work *>(data));
    w->session->busy = false;
    try {
        if (w->failed || status != napi_ok) {
            napi_value error;
            check(napi_create_error(env, text(env, "CAPTURE_FAILED"), text(env, "The native capture operation failed."), &error));
            check(napi_reject_deferred(env, w->deferred, error));
        } else {
            napi_value value = metadata(env, w->session);
            if (w->operation == Operation::prepare) {
                set(env, value, "sampleCount", number(env, double(w->session->output_count.load())));
                set(env, value, "chunkCount", number(env, double(w->session->prepared.size())));
            }
            check(napi_resolve_deferred(env, w->deferred, value));
        }
    } catch (...) { napi_fatal_error("capture", NAPI_AUTO_LENGTH, "Invalid capture completion.", NAPI_AUTO_LENGTH); }
    napi_delete_async_work(env, w->work);
}
napi_value queue(napi_env env, const Shared & session, Operation operation,
                 std::string source = {}, std::string server = {}) {
    bool expected = false;
    if (!session->busy.compare_exchange_strong(expected, true)) throw std::runtime_error("CAPTURE_FAILED");
    auto w = std::make_unique<Work>();
    w->env = env; w->session = session; w->operation = operation; w->source = std::move(source); w->server = std::move(server);
    try {
        napi_value promise;
        check(napi_create_promise(env, &w->deferred, &promise));
        check(napi_create_async_work(env, nullptr, text(env, "OpenWhisperCapture"), execute, complete, w.get(), &w->work));
        check(napi_queue_async_work(env, w->work)); w.release(); return promise;
    } catch (...) { if (w->work) napi_delete_async_work(env, w->work); session->busy = false; throw; }
}
void finalize_session(napi_env, void * data, void *) { delete static_cast<Shared *>(data); }
napi_value create(napi_env env, napi_callback_info info) noexcept {
    try {
        auto values = args(env, info, 4);
        const double generation = integer(env, values[0], 1, maximum_safe_integer);
        bool synthetic; check(napi_get_value_bool(env, values[1], &synthetic));
        const auto rate = uint32_t(integer(env, values[2], 8000, 192000));
        const auto channels = uint32_t(integer(env, values[3], 1, 8));
        auto s = std::make_unique<Shared>(std::make_shared<Session>(generation, synthetic, rate, channels));
        napi_value value = object(env);
        check(napi_type_tag_object(env, value, &session_tag));
        check(napi_wrap(env, value, s.get(), finalize_session, nullptr, nullptr)); s.release(); return value;
    } catch (...) { return failure(env); }
}
napi_value start_call(napi_env env, napi_callback_info info) noexcept {
    try {
        auto v = args(env, info, 3); return queue(env, owner(env, v[0]), Operation::start,
                                               string(env, v[1], 255), string(env, v[2], 4096));
    } catch (...) { return failure(env); }
}
template<Operation operation> napi_value operation_call(napi_env env, napi_callback_info info) noexcept {
    try { return queue(env, owner(env, args(env, info, 1)[0]), operation); }
    catch (...) { return failure(env); }
}
napi_value status_call(napi_env env, napi_callback_info info) noexcept {
    try { return metadata(env, owner(env, args(env, info, 1)[0])); } catch (...) { return failure(env); }
}
napi_value feed(napi_env env, napi_callback_info info) noexcept {
    try {
        auto v = args(env, info, 2); auto s = owner(env, v[0]);
        if (!s->synthetic || s->busy || !s->running || s->closed || s->released || s->start_cancelled)
            throw std::runtime_error("CAPTURE_FAILED");
        napi_typedarray_type type; size_t count, offset; void * data; napi_value buffer;
        check(napi_get_typedarray_info(env, v[1], &type, &count, &data, &buffer, &offset));
        if (type != napi_float32_array || !data || count == 0 || count > 192000 * 8 || count % s->channels)
            throw std::runtime_error("CAPTURE_FAILED");
        const auto input = static_cast<const float *>(data);
        for (size_t i = 0; i < count; i++) if (!std::isfinite(input[i])) throw std::runtime_error("CAPTURE_FAILED");
        s->append(input, count); return nothing(env);
    } catch (...) { return failure(env); }
}
napi_value inject_error(napi_env env, napi_callback_info info) noexcept {
    try {
        auto s = owner(env, args(env, info, 1)[0]);
        if (!s->synthetic || s->released) throw std::runtime_error("CAPTURE_FAILED");
        s->fail(Failure::injected); return nothing(env);
    } catch (...) { return failure(env); }
}
void append_synthetic_fragment(void * data, const void * input, ma_uint32 frames) {
    auto & s = *static_cast<Session *>(data);
    s.append(static_cast<const float *>(input), size_t(frames) * s.channels.load());
}
napi_value feed_hole(napi_env env, napi_callback_info info) noexcept {
    try {
        auto v = args(env, info, 2); auto s = owner(env, v[0]);
        if (!s->synthetic || s->busy || !s->running || s->closed || s->released || s->start_cancelled)
            throw std::runtime_error("CAPTURE_FAILED");
        const auto bytes = size_t(integer(env, v[1], 1, 192000 * 8 * sizeof(float)));
        if (wf_capture_visit_fragment(nullptr, bytes, ma_format_f32, s->channels, s.get(), append_synthetic_fragment) != 0)
            throw std::runtime_error("CAPTURE_FAILED");
        return nothing(env);
    } catch (...) { return failure(env); }
}
napi_value abort_start(napi_env env, napi_callback_info info) noexcept {
    try { owner(env, args(env, info, 1)[0])->start_cancelled = true; return nothing(env); }
    catch (...) { return failure(env); }
}
napi_value read_chunk(napi_env env, napi_callback_info info) noexcept {
    try {
        auto v = args(env, info, 2); auto s = owner(env, v[0]);
        if (s->busy || !s->closed || s->released) throw std::runtime_error("CAPTURE_FAILED");
        const auto index = size_t(integer(env, v[1], 0, maximum_safe_integer));
        if (index >= s->prepared.size() || !s->prepared[index]) throw std::runtime_error("CAPTURE_FAILED");
        const auto chunk = s->prepared[index];
        napi_value buffer, value;
        const size_t count = chunk->size();
        // Electron's memory cage need not support external ArrayBuffers. Only a bounded chunk is copied.
        void * destination = nullptr;
        check(napi_create_arraybuffer(env, count * sizeof(float), &destination, &buffer));
        std::memcpy(destination, chunk->data(), count * sizeof(float));
        check(napi_create_typedarray(env, napi_float32_array, count, buffer, 0, &value));
        s->prepared[index].reset(); return value;
    } catch (...) { return failure(env); }
}
napi_value initialize(napi_env env, napi_value exports) noexcept {
    try {
        const napi_property_descriptor properties[] = {
            {"enumerate", nullptr, enumerate_call, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"start", nullptr, start_call, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"closeAndFence", nullptr, operation_call<Operation::close>, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepare", nullptr, operation_call<Operation::prepare>, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"release", nullptr, operation_call<Operation::release>, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"status", nullptr, status_call, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"feed", nullptr, feed, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"feedHole", nullptr, feed_hole, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"injectError", nullptr, inject_error, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"abortStart", nullptr, abort_start, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"readPreparedChunk", nullptr, read_chunk, nullptr, nullptr, nullptr, napi_default, nullptr},
        };
        check(napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties)); return exports;
    } catch (...) { return failure(env); }
}
} // namespace
extern "C" void wf_capture_signal_failure(void * data, int reason) {
    auto & s = *static_cast<Session *>(data);
    const Failure failures[] = {Failure::peek, Failure::hole, Failure::format, Failure::drop};
    s.fail(reason >= 0 && reason < 4 ? failures[reason] : Failure::backend, true);
}
NAPI_MODULE(openwhisper_capture, initialize)
