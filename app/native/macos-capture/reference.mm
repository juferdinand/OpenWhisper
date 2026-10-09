// Synthetic-only independent full-stream Apple conversion reference. No engine or device.
#import <AVFoundation/AVFoundation.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <vector>

std::vector<float> wf_macos_reference(const std::vector<AVAudioPCMBuffer *> & input) {
    if (input.empty()) throw std::runtime_error("CAPTURE_FAILED");
    AVAudioFormat * format = input.front().format;
    uint64_t frames = 0;
    for (AVAudioPCMBuffer * buffer : input) frames += buffer.frameLength;
    if (frames == 0 || frames > UINT32_MAX) throw std::runtime_error("CAPTURE_FAILED");
    AVAudioPCMBuffer * all = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:AVAudioFrameCount(frames)];
    if (!all) throw std::bad_alloc(); all.frameLength = AVAudioFrameCount(frames);
    size_t position = 0;
    for (AVAudioPCMBuffer * buffer : input) {
        for (UInt32 index = 0; index < buffer.audioBufferList->mNumberBuffers; index++) {
            const size_t stride = buffer.audioBufferList->mBuffers[index].mNumberChannels * sizeof(float);
            std::memcpy(static_cast<char *>(all.mutableAudioBufferList->mBuffers[index].mData) + position * stride,
                buffer.audioBufferList->mBuffers[index].mData, size_t(buffer.frameLength) * stride);
        }
        position += buffer.frameLength;
    }
    AVAudioFormat * output_format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
    AVAudioConverter * reference = [[AVAudioConverter alloc] initFromFormat:format toFormat:output_format];
    if (!reference) throw std::runtime_error("CAPTURE_FAILED");
    const auto capacity = uint64_t(std::ceil(double(frames) * 16000 / format.sampleRate)) + 1024;
    if (capacity > UINT32_MAX) throw std::runtime_error("CAPTURE_FAILED");
    __block uint64_t consumed = 0;
    __block bool input_failed = false;
    std::vector<float> result;
    for (unsigned pass = 0; pass < 32; pass++) {
        AVAudioPCMBuffer * converted = [[AVAudioPCMBuffer alloc] initWithPCMFormat:output_format frameCapacity:AVAudioFrameCount(capacity)];
        if (!converted) throw std::bad_alloc(); NSError * error = nil;
        const auto status = [reference convertToBuffer:converted error:&error withInputFromBlock:^AVAudioBuffer * (AVAudioPacketCount requested, AVAudioConverterInputStatus * state) {
            if (consumed == frames) { *state = AVAudioConverterInputStatus_EndOfStream; return nil; }
            const auto count = uint32_t(std::min(uint64_t(requested), frames - consumed));
            if (count == 0) { input_failed = true; *state = AVAudioConverterInputStatus_NoDataNow; return nil; }
            AVAudioPCMBuffer * part = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:count];
            if (!part) { input_failed = true; *state = AVAudioConverterInputStatus_NoDataNow; return nil; }
            part.frameLength = count;
            for (UInt32 index = 0; index < all.audioBufferList->mNumberBuffers; index++) {
                const auto stride = all.audioBufferList->mBuffers[index].mNumberChannels * sizeof(float);
                std::memcpy(part.mutableAudioBufferList->mBuffers[index].mData,
                    static_cast<char *>(all.audioBufferList->mBuffers[index].mData) + consumed * stride, count * stride);
            }
            consumed += count; *state = AVAudioConverterInputStatus_HaveData; return part;
        }];
        if (input_failed || error || status == AVAudioConverterOutputStatus_Error) throw std::runtime_error("CAPTURE_FAILED");
        const auto samples = converted.floatChannelData[0];
        for (AVAudioFrameCount i = 0; i < converted.frameLength; i++) {
            if (!std::isfinite(samples[i])) throw std::runtime_error("CAPTURE_FAILED");
            result.push_back(samples[i]);
        }
        if (status == AVAudioConverterOutputStatus_EndOfStream && consumed == frames) return result;
    }
    throw std::runtime_error("CAPTURE_FAILED");
}
