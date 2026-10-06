#include "whisper.h"
#include "parakeet.h"
#include <algorithm>
#include <exception>
#include <string>
#include <thread>

// The owning Rust worker serializes every call and copies returned strings before the next call.
struct SpeechContext {
    whisper_context * whisper = nullptr;
    parakeet_context * parakeet = nullptr;
    std::string path;
    std::string error;
    std::string text;
    bool gpu = false;
    void unload() {
        if (whisper) whisper_free(whisper);
        if (parakeet) parakeet_free(parakeet);
        whisper = nullptr;
        parakeet = nullptr;
        path.clear();
    }
    ~SpeechContext() { unload(); }
};

extern "C" {
void * wf_speech_create() noexcept {
    try { return new SpeechContext(); } catch (...) { return nullptr; }
}
void wf_speech_destroy(void * pointer) noexcept { delete static_cast<SpeechContext *>(pointer); }
const char * wf_speech_error(void * pointer) noexcept { return static_cast<SpeechContext *>(pointer)->error.c_str(); }
int wf_speech_load(void * pointer, const char * path, bool is_parakeet, bool gpu) noexcept {
    auto & ctx = *static_cast<SpeechContext *>(pointer);
    try {
        if (ctx.path == path && ctx.gpu == gpu && (ctx.whisper || ctx.parakeet)) return 0;
        ctx.unload();
        ctx.error.clear();
        if (is_parakeet) {
            auto parameters = parakeet_context_default_params();
            parameters.use_gpu = gpu;
            ctx.parakeet = parakeet_init_from_file_with_params(path, parameters);
        } else {
            auto parameters = whisper_context_default_params();
            parameters.use_gpu = gpu;
            ctx.whisper = whisper_init_from_file_with_params(path, parameters);
        }
        if (!ctx.whisper && !ctx.parakeet) {
            ctx.error = "Could not load the selected speech model.";
            return -1;
        }
        ctx.path = path;
        ctx.gpu = gpu;
        return 0;
    } catch (const std::exception & error) { ctx.error = error.what(); return -1; }
      catch (...) { ctx.error = "Native model loading failed."; return -1; }
}
const char * wf_speech_transcribe(void * pointer, const float * samples, int count,
                                  const char * language, const char * prompt) noexcept {
    auto & ctx = *static_cast<SpeechContext *>(pointer);
    try {
        ctx.text.clear();
        ctx.error.clear();
        if (!samples || count <= 0) { ctx.error = "No audio samples."; return nullptr; }
        const int threads = std::max(1, std::min(8, static_cast<int>(std::thread::hardware_concurrency()) - 2));
        if (ctx.whisper) {
            auto parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            parameters.n_threads = threads;
            parameters.language = language;
            parameters.initial_prompt = prompt && *prompt ? prompt : nullptr;
            parameters.translate = false;
            parameters.no_context = true;
            parameters.no_timestamps = true;
            parameters.print_special = false;
            parameters.print_progress = false;
            parameters.print_realtime = false;
            parameters.print_timestamps = false;
            parameters.suppress_blank = true;
            if (whisper_full(ctx.whisper, parameters, samples, count)) {
                ctx.error = "Whisper transcription failed."; return nullptr;
            }
            for (int i = 0; i < whisper_full_n_segments(ctx.whisper); ++i)
                ctx.text += whisper_full_get_segment_text(ctx.whisper, i);
        } else if (ctx.parakeet) {
            auto parameters = parakeet_full_default_params(PARAKEET_SAMPLING_GREEDY);
            parameters.n_threads = threads;
            parameters.no_context = true;
            if (parakeet_full(ctx.parakeet, parameters, samples, count)) {
                ctx.error = "Parakeet transcription failed."; return nullptr;
            }
            for (int i = 0; i < parakeet_full_n_segments(ctx.parakeet); ++i) {
                if (i) ctx.text += ' ';
                ctx.text += parakeet_full_get_segment_text(ctx.parakeet, i);
            }
        } else { ctx.error = "No speech model is loaded."; return nullptr; }
        return ctx.text.c_str();
    } catch (const std::exception & error) { ctx.error = error.what(); return nullptr; }
      catch (...) { ctx.error = "Native transcription failed."; return nullptr; }
}
}
