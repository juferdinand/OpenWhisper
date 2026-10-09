// A synchronous Node-API boundary loaded only by the disposable speech process.
// Application policy, windowing, chunking and retries stay in TypeScript.
#include <node_api.h>
#include "whisper.h"
#include "parakeet.h"
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
void * wf_speech_create() noexcept;
void wf_speech_destroy(void *) noexcept;
const char * wf_speech_gpu_name() noexcept;
int wf_speech_load(void *, const char *, bool, bool) noexcept;
const char * wf_speech_transcribe(void *, const float *, int, const char *, const char *) noexcept;
}

struct Owner {
    void * context = nullptr;
    ~Owner() { if (context) wf_speech_destroy(context); }
};

static void check(napi_status status) {
    if (status != napi_ok) throw std::runtime_error("Invalid native speech call.");
}
static Owner & owner(napi_env env) {
    void * data = nullptr;
    check(napi_get_instance_data(env, &data));
    if (!data || !static_cast<Owner *>(data)->context) throw std::runtime_error("Speech context is closed.");
    return *static_cast<Owner *>(data);
}
static std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t expected) {
    size_t count = expected + 1;
    std::vector<napi_value> values(count);
    check(napi_get_cb_info(env, info, &count, values.data(), nullptr, nullptr));
    if (count != expected) throw std::runtime_error("Invalid native speech argument count.");
    values.resize(expected);
    return values;
}
static std::string string(napi_env env, napi_value value, size_t maximum) {
    size_t length = 0;
    check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
    if (length > maximum) throw std::runtime_error("Native speech string exceeds its limit.");
    std::vector<char> bytes(length + 1);
    size_t actual = 0;
    check(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &actual));
    std::string result(bytes.data(), actual);
    if (result.find('\0') != std::string::npos) throw std::runtime_error("Invalid native speech string.");
    return result;
}
static napi_value nothing(napi_env env) {
    napi_value result;
    check(napi_get_undefined(env, &result));
    return result;
}
static napi_value failure(napi_env env) noexcept {
    // Never expose native diagnostics: they may contain model paths or prompts.
    napi_throw_error(env, "SPEECH_FAILED", "The native speech operation failed.");
    return nullptr;
}
static napi_value gpu(napi_env env, napi_callback_info info) noexcept {
    try {
        arguments(env, info, 0);
        owner(env);
        napi_value result;
        const char * name = wf_speech_gpu_name();
        if (name) check(napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &result));
        else check(napi_get_null(env, &result));
        return result;
    } catch (...) { return failure(env); }
}
static napi_value load(napi_env env, napi_callback_info info) noexcept {
    try {
        const auto values = arguments(env, info, 3);
        const auto path = string(env, values[0], 4096);
        bool parakeet = false, use_gpu = false;
        check(napi_get_value_bool(env, values[1], &parakeet));
        check(napi_get_value_bool(env, values[2], &use_gpu));
        if (path.empty() || wf_speech_load(owner(env).context, path.c_str(), parakeet, use_gpu))
            throw std::runtime_error("Speech model loading failed.");
        return nothing(env);
    } catch (...) { return failure(env); }
}
static napi_value transcribe(napi_env env, napi_callback_info info) noexcept {
    try {
        const auto values = arguments(env, info, 3);
        napi_typedarray_type type;
        size_t length = 0, offset = 0;
        void * data = nullptr;
        napi_value buffer;
        check(napi_get_typedarray_info(env, values[0], &type, &length, &data, &buffer, &offset));
        if (type != napi_float32_array || !data || length == 0 || length > 30 * 16000)
            throw std::runtime_error("Invalid native inference window.");
        auto samples = static_cast<const float *>(data);
        for (size_t i = 0; i < length; ++i) if (!std::isfinite(samples[i]))
            throw std::runtime_error("Invalid native audio sample.");
        const auto language = string(env, values[1], 16);
        const auto prompt = string(env, values[2], 4 * 1024 * 1024);
        const char * text = wf_speech_transcribe(owner(env).context, samples, static_cast<int>(length),
                                                language.c_str(), prompt.c_str());
        if (!text) throw std::runtime_error("Native inference failed.");
        napi_value result;
        check(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result));
        return result;
    } catch (...) { return failure(env); }
}
static napi_value shutdown(napi_env env, napi_callback_info info) noexcept {
    try {
        arguments(env, info, 0);
        void * data = nullptr;
        check(napi_get_instance_data(env, &data));
        if (data) {
            auto & state = *static_cast<Owner *>(data);
            if (state.context) wf_speech_destroy(state.context);
            state.context = nullptr;
        }
        return nothing(env);
    } catch (...) { return failure(env); }
}
static void quiet_log(ggml_log_level, const char *, void *) {}
static void finalize(napi_env, void * data, void *) { delete static_cast<Owner *>(data); }
static napi_value initialize(napi_env env, napi_value exports) {
    try {
        whisper_log_set(quiet_log, nullptr);
        parakeet_log_set(quiet_log, nullptr);
        ggml_log_set(quiet_log, nullptr);
        auto state = new Owner();
        state->context = wf_speech_create();
        if (!state->context) { delete state; throw std::runtime_error("Speech initialization failed."); }
        if (napi_set_instance_data(env, state, finalize, nullptr) != napi_ok) {
            delete state;
            throw std::runtime_error("Speech initialization failed.");
        }
        const napi_property_descriptor properties[] = {
            {"gpuDevice", nullptr, gpu, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"load", nullptr, load, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"transcribe", nullptr, transcribe, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"shutdown", nullptr, shutdown, nullptr, nullptr, nullptr, napi_default, nullptr},
        };
        check(napi_define_properties(env, exports, 4, properties));
        return exports;
    } catch (...) { return failure(env); }
}
NAPI_MODULE(openwhisper_speech, initialize)
