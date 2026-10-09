#pragma once
#include <cmath>
#include <cstdint>
#include <functional>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <memory>
#include <node_api.h>
#include <stdexcept>
#include <string>
#include <vector>

namespace owbus {
constexpr size_t max_bytes = 65536;
constexpr size_t max_nodes = 4096;
constexpr size_t max_depth = 16;
constexpr size_t max_fds = 16;
struct Invalid : std::runtime_error {
  Invalid() : std::runtime_error("INVALID_FRAME") {}
};
inline void check(bool valid) {
  if (!valid)
    throw Invalid();
}
inline void ok(napi_status status) { check(status == napi_ok); }
struct VariantDelete {
  void operator()(GVariant *value) const {
    if (value)
      g_variant_unref(value);
  }
};
using Variant = std::unique_ptr<GVariant, VariantDelete>;
inline Variant own(GVariant *value) {
  check(value != nullptr);
  return Variant(g_variant_ref_sink(value));
}
struct ObjectDelete {
  void operator()(GObject *value) const {
    if (value)
      g_object_unref(value);
  }
};

std::string string(napi_env env, napi_value value, size_t maximum = 8192);
napi_value string(napi_env env, const std::string &value);
napi_value object(napi_env env);
void put(napi_env env, napi_value target, const char *key, napi_value value);
napi_value get(napi_env env, napi_value target, const char *key);
void fields(napi_env env, napi_value value,
            std::initializer_list<const char *> keys);
bool boolean(napi_env env, napi_value value);
double number(napi_env env, napi_value value);
napi_value number(napi_env env, double value);
napi_value boolean(napi_env env, bool value);
std::string uuid();
bool is_uuid(const std::string &value);
void signature(const std::string &value, bool single = false);

// FDs never cross the Node process boundary as integers. Both callbacks operate
// on holders belonging to this exact connection and duplicate/consume locally.
using InputFd = std::function<int(const std::string &)>;
using OutputFd = std::function<std::string(int)>;
Variant body_from_js(napi_env env, napi_value values, GUnixFDList *fds,
                     const InputFd &lookup);
napi_value body_to_js(napi_env env, GVariant *body, GUnixFDList *fds,
                      const OutputFd &retain);
std::string body_signature(GVariant *body);
} // namespace owbus
