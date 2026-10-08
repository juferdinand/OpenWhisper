#include "codec.hpp"
#include <algorithm>
#include <cstring>
#include <limits>
#include <set>
#include <unistd.h>

namespace owbus {
std::string string(napi_env env, napi_value value, size_t maximum) {
  napi_valuetype kind;
  ok(napi_typeof(env, value, &kind));
  check(kind == napi_string);
  size_t units = 0;
  ok(napi_get_value_string_utf16(env, value, nullptr, 0, &units));
  check(units <= maximum);
  std::vector<char16_t> utf16(units + 1);
  size_t unit_count = 0;
  ok(napi_get_value_string_utf16(env, value, utf16.data(), utf16.size(),
                                 &unit_count));
  check(unit_count == units);
  // UTF8 conversion substitutes unpaired UTF16 surrogates. Validate first so
  // malformed input is refused rather than changing text silently.
  for (size_t i = 0; i < units; ++i) {
    char16_t unit = utf16[i];
    check(unit != 0);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      check(i + 1 < units && utf16[i + 1] >= 0xdc00 && utf16[i + 1] <= 0xdfff);
      ++i;
    } else
      check(unit < 0xdc00 || unit > 0xdfff);
  }
  size_t length = 0;
  ok(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  check(length <= maximum);
  std::vector<char> bytes(length + 1);
  size_t copied = 0;
  ok(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(),
                                &copied));
  check(copied == length &&
        std::find(bytes.begin(), bytes.end() - 1, '\0') == bytes.end() - 1);
  check(g_utf8_validate(bytes.data(), static_cast<gssize>(length), nullptr));
  return std::string(bytes.data(), length);
}
napi_value string(napi_env env, const std::string &value) {
  napi_value result;
  ok(napi_create_string_utf8(env, value.data(), value.size(), &result));
  return result;
}
napi_value object(napi_env env) {
  napi_value value;
  ok(napi_create_object(env, &value));
  return value;
}
void put(napi_env env, napi_value target, const char *key, napi_value value) {
  ok(napi_set_named_property(env, target, key, value));
}
napi_value get(napi_env env, napi_value target, const char *key) {
  bool present = false;
  ok(napi_has_own_property(env, target, string(env, key), &present));
  check(present);
  napi_value result;
  ok(napi_get_named_property(env, target, key, &result));
  return result;
}
void fields(napi_env env, napi_value value,
            std::initializer_list<const char *> keys) {
  napi_valuetype kind;
  ok(napi_typeof(env, value, &kind));
  check(kind == napi_object);
  bool array = false;
  ok(napi_is_array(env, value, &array));
  check(!array);
  napi_value names;
  ok(napi_get_property_names(env, value, &names));
  uint32_t count;
  ok(napi_get_array_length(env, names, &count));
  check(count == keys.size());
  std::set<std::string> remaining;
  for (auto key : keys)
    remaining.insert(key);
  for (uint32_t i = 0; i < count; ++i) {
    napi_value name;
    ok(napi_get_element(env, names, i, &name));
    check(remaining.erase(string(env, name, 128)) == 1);
  }
}
bool boolean(napi_env env, napi_value value) {
  bool result;
  ok(napi_get_value_bool(env, value, &result));
  return result;
}
double number(napi_env env, napi_value value) {
  double result;
  ok(napi_get_value_double(env, value, &result));
  check(std::isfinite(result));
  return result;
}
napi_value number(napi_env env, double value) {
  check(std::isfinite(value));
  napi_value result;
  ok(napi_create_double(env, value, &result));
  return result;
}
napi_value boolean(napi_env env, bool value) {
  napi_value result;
  ok(napi_get_boolean(env, value, &result));
  return result;
}
std::string uuid() {
  gchar *value = g_uuid_string_random();
  std::string result(value);
  g_free(value);
  return result;
}
bool is_uuid(const std::string &value) {
  return g_uuid_string_is_valid(value.c_str());
}
void signature(const std::string &value, bool single) {
  check(value.size() <= 128 && g_variant_is_signature(value.c_str()));
  if (single)
    check(!value.empty() && g_variant_type_string_is_valid(value.c_str()));
  size_t index = 0;
  std::function<bool(size_t, bool)> consume = [&](size_t depth, bool entry) {
    if (depth > max_depth || index >= value.size())
      return false;
    char item = value[index++];
    if (std::strchr("ybnqiuxtdsoghv", item))
      return true;
    if (item == 'a')
      return consume(depth + 1, true);
    if (item == '(') {
      size_t start = index;
      while (index < value.size() && value[index] != ')')
        if (!consume(depth + 1, false))
          return false;
      if (index == value.size() || index == start)
        return false;
      ++index;
      return true;
    }
    if (item == '{' && entry) {
      if (index >= value.size() ||
          !std::strchr("ybnqiuxtdsogh", value[index++]))
        return false;
      if (!consume(depth + 1, false) || index >= value.size() ||
          value[index++] != '}')
        return false;
      return true;
    }
    return false;
  };
  size_t members = 0;
  while (index < value.size()) {
    check(consume(0, false));
    ++members;
  }
  check(!single || members == 1);
}
std::string body_signature(GVariant *body) {
  if (!body)
    return "";
  check(g_variant_is_of_type(body, G_VARIANT_TYPE_TUPLE));
  std::string result(g_variant_get_type_string(body));
  check(result.size() >= 2);
  result = result.substr(1, result.size() - 2);
  signature(result);
  return result;
}
struct Budget {
  size_t nodes = 0, bytes = 0;
  void use(size_t depth, size_t size = 0) {
    check(depth <= max_depth && ++nodes <= max_nodes);
    bytes += size;
    check(bytes <= max_bytes);
  }
};
static uint32_t length(napi_env env, napi_value value, uint32_t maximum) {
  bool array;
  ok(napi_is_array(env, value, &array));
  check(array);
  uint32_t result;
  ok(napi_get_array_length(env, value, &result));
  check(result <= maximum);
  return result;
}
static napi_value element(napi_env env, napi_value value, uint32_t index) {
  bool present = false;
  ok(napi_has_element(env, value, index, &present));
  check(present);
  napi_value result;
  ok(napi_get_element(env, value, index, &result));
  return result;
}
static double integer(napi_env env, napi_value value, double low, double high) {
  double result = number(env, value);
  check(result >= low && result <= high && std::trunc(result) == result);
  return result;
}
static bool canonical(const std::string &value, bool negative) {
  size_t begin = negative && !value.empty() && value[0] == '-' ? 1 : 0;
  if (begin == value.size() || value.size() > 21)
    return false;
  if (value[begin] == '0')
    return begin == 0 && value.size() == 1;
  return value[begin] >= '1' && value[begin] <= '9' &&
         std::all_of(value.begin() + static_cast<long>(begin), value.end(),
                     [](char c) { return c >= '0' && c <= '9'; });
}
static Variant from_js(napi_env env, napi_value value, size_t depth,
                       Budget &budget, GUnixFDList *fds,
                       const InputFd &lookup) {
  budget.use(depth);
  std::string kind = string(env, get(env, value, "type"), 8);
  if (kind == "h") {
    fields(env, value, {"type", "token"});
    auto token = string(env, get(env, value, "token"), 36);
    check(is_uuid(token));
    check(g_unix_fd_list_get_length(fds) < static_cast<int>(max_fds));
    int fd = lookup(token);
    check(fd >= 0);
    GError *error = nullptr;
    int index = g_unix_fd_list_append(fds, fd, &error);
    ::close(fd);
    if (error) {
      g_error_free(error);
      throw Invalid();
    }
    check(index >= 0);
    return own(g_variant_new_handle(index));
  }
  if (kind == "a" || kind == "r") {
    if (kind == "a")
      fields(env, value, {"type", "element", "value"});
    else
      fields(env, value, {"type", "value"});
    napi_value list = get(env, value, "value");
    uint32_t count = length(env, list, kind == "r" ? 32 : 1024);
    check(kind != "r" || count > 0);
    std::vector<Variant> children;
    std::vector<GVariant *> pointers;
    std::string type =
        kind == "a" ? string(env, get(env, value, "element"), 128) : "";
    if (kind == "a")
      signature(type, true);
    for (uint32_t i = 0; i < count; ++i) {
      children.push_back(
          from_js(env, element(env, list, i), depth + 1, budget, fds, lookup));
      if (kind == "a")
        check(type == g_variant_get_type_string(children.back().get()));
      pointers.push_back(children.back().get());
    }
    if (kind == "r")
      return own(g_variant_new_tuple(pointers.data(), pointers.size()));
    GVariantType *subtype = g_variant_type_new(type.c_str());
    auto result =
        own(g_variant_new_array(subtype, pointers.data(), pointers.size()));
    g_variant_type_free(subtype);
    return result;
  }
  if (kind == "dict") {
    fields(env, value, {"type", "key", "member", "value"});
    auto key = string(env, get(env, value, "key"), 1);
    check(key.size() == 1 && std::strchr("ybnqiuxtdsog", key[0]));
    auto member = string(env, get(env, value, "member"), 128);
    signature(member, true);
    napi_value list = get(env, value, "value");
    uint32_t count = length(env, list, 1024);
    std::vector<Variant> entries;
    std::vector<GVariant *> pointers;
    std::set<std::string> keys;
    for (uint32_t i = 0; i < count; ++i) {
      auto entry = element(env, list, i);
      fields(env, entry, {"key", "value"});
      auto first =
          from_js(env, get(env, entry, "key"), depth + 1, budget, fds, lookup);
      auto second = from_js(env, get(env, entry, "value"), depth + 1, budget,
                            fds, lookup);
      check(key == g_variant_get_type_string(first.get()) &&
            member == g_variant_get_type_string(second.get()));
      gchar *printed = g_variant_print(first.get(), TRUE);
      bool unique = keys.insert(printed).second;
      g_free(printed);
      check(unique);
      entries.push_back(
          own(g_variant_new_dict_entry(first.get(), second.get())));
      pointers.push_back(entries.back().get());
    }
    std::string entry_type = "{" + key + member + "}";
    GVariantType *subtype = g_variant_type_new(entry_type.c_str());
    auto result =
        own(g_variant_new_array(subtype, pointers.data(), pointers.size()));
    g_variant_type_free(subtype);
    return result;
  }
  if (kind == "v") {
    fields(env, value, {"type", "signature", "value"});
    auto type = string(env, get(env, value, "signature"), 128);
    signature(type, true);
    auto child =
        from_js(env, get(env, value, "value"), depth + 1, budget, fds, lookup);
    check(type == g_variant_get_type_string(child.get()));
    return own(g_variant_new_variant(child.get()));
  }
  fields(env, value, {"type", "value"});
  auto data = get(env, value, "value");
  if (kind == "b")
    return own(g_variant_new_boolean(boolean(env, data)));
  if (kind == "y")
    return own(
        g_variant_new_byte(static_cast<guchar>(integer(env, data, 0, 255))));
  if (kind == "n")
    return own(g_variant_new_int16(
        static_cast<gint16>(integer(env, data, -32768, 32767))));
  if (kind == "q")
    return own(g_variant_new_uint16(
        static_cast<guint16>(integer(env, data, 0, 65535))));
  if (kind == "i")
    return own(g_variant_new_int32(
        static_cast<gint32>(integer(env, data, -2147483648., 2147483647.))));
  if (kind == "u")
    return own(g_variant_new_uint32(
        static_cast<guint32>(integer(env, data, 0, 4294967295.))));
  if (kind == "d")
    return own(g_variant_new_double(number(env, data)));
  if (kind == "x" || kind == "t") {
    auto text = string(env, data, 21);
    check(canonical(text, kind == "x"));
    try {
      if (kind == "x")
        return own(g_variant_new_int64(std::stoll(text)));
      return own(g_variant_new_uint64(std::stoull(text)));
    } catch (const std::exception &) {
      throw Invalid();
    }
  }
  auto text = string(env, data);
  budget.bytes += text.size();
  check(budget.bytes <= max_bytes);
  if (kind == "s")
    return own(g_variant_new_string(text.c_str()));
  if (kind == "o") {
    check(g_variant_is_object_path(text.c_str()));
    return own(g_variant_new_object_path(text.c_str()));
  }
  if (kind == "g") {
    signature(text);
    return own(g_variant_new_signature(text.c_str()));
  }
  throw Invalid();
}
Variant body_from_js(napi_env env, napi_value values, GUnixFDList *fds,
                     const InputFd &lookup) {
  uint32_t count = length(env, values, 32);
  Budget budget;
  std::vector<Variant> members;
  std::vector<GVariant *> pointers;
  for (uint32_t i = 0; i < count; ++i) {
    members.push_back(
        from_js(env, element(env, values, i), 0, budget, fds, lookup));
    pointers.push_back(members.back().get());
  }
  auto result = own(g_variant_new_tuple(pointers.data(), pointers.size()));
  check(g_variant_get_size(result.get()) <= max_bytes);
  body_signature(result.get());
  return result;
}
static napi_value to_js(napi_env env, GVariant *value, size_t depth,
                        Budget &budget, GUnixFDList *fds,
                        const OutputFd &retain) {
  budget.use(depth);
  auto result = object(env);
  std::string kind(1, g_variant_get_type_string(value)[0]);
  auto tag = [&](const std::string &type) {
    put(env, result, "type", string(env, type));
  };
  if (kind == "h") {
    check(fds && g_unix_fd_list_get_length(fds) <= static_cast<int>(max_fds));
    int index = g_variant_get_handle(value);
    check(index >= 0 && index < g_unix_fd_list_get_length(fds));
    GError *error = nullptr;
    int fd = g_unix_fd_list_get(fds, index, &error);
    if (error) {
      g_error_free(error);
      throw Invalid();
    }
    check(fd >= 0);
    tag("h");
    // retain consumes the duplicate on both success and failure.
    put(env, result, "token", string(env, retain(fd)));
    return result;
  }
  if (kind == "a" || kind == "(") {
    size_t count = g_variant_n_children(value);
    bool dictionary =
        kind == "a" && g_variant_type_is_dict_entry(
                           g_variant_type_element(g_variant_get_type(value)));
    check(count <= (kind == "(" ? 32 : 1024));
    check(kind != "(" || count != 0);
    napi_value list;
    ok(napi_create_array_with_length(env, count, &list));
    if (dictionary) {
      tag("dict");
      const GVariantType *entry =
          g_variant_type_element(g_variant_get_type(value));
      gchar *key = g_variant_type_dup_string(g_variant_type_key(entry));
      gchar *member = g_variant_type_dup_string(g_variant_type_value(entry));
      put(env, result, "key", string(env, key));
      put(env, result, "member", string(env, member));
      g_free(key);
      g_free(member);
    } else {
      tag(kind == "(" ? "r" : "a");
      if (kind == "a") {
        gchar *subtype = g_variant_type_dup_string(
            g_variant_type_element(g_variant_get_type(value)));
        put(env, result, "element", string(env, subtype));
        g_free(subtype);
      }
    }
    for (size_t i = 0; i < count; ++i) {
      Variant child(g_variant_get_child_value(value, i));
      napi_value item;
      if (dictionary) {
        item = object(env);
        Variant key(g_variant_get_child_value(child.get(), 0)),
            data(g_variant_get_child_value(child.get(), 1));
        put(env, item, "key",
            to_js(env, key.get(), depth + 1, budget, fds, retain));
        put(env, item, "value",
            to_js(env, data.get(), depth + 1, budget, fds, retain));
      } else
        item = to_js(env, child.get(), depth + 1, budget, fds, retain);
      ok(napi_set_element(env, list, static_cast<uint32_t>(i), item));
    }
    put(env, result, "value", list);
    return result;
  }
  if (kind == "v") {
    Variant child(g_variant_get_variant(value));
    tag("v");
    put(env, result, "signature",
        string(env, g_variant_get_type_string(child.get())));
    put(env, result, "value",
        to_js(env, child.get(), depth + 1, budget, fds, retain));
    return result;
  }
  tag(kind);
  napi_value data;
  if (kind == "b")
    data = boolean(env, g_variant_get_boolean(value));
  else if (kind == "y")
    data = number(env, g_variant_get_byte(value));
  else if (kind == "n")
    data = number(env, g_variant_get_int16(value));
  else if (kind == "q")
    data = number(env, g_variant_get_uint16(value));
  else if (kind == "i")
    data = number(env, g_variant_get_int32(value));
  else if (kind == "u")
    data = number(env, g_variant_get_uint32(value));
  else if (kind == "d")
    data = number(env, g_variant_get_double(value));
  else if (kind == "x")
    data = string(env, std::to_string(g_variant_get_int64(value)));
  else if (kind == "t")
    data = string(env, std::to_string(g_variant_get_uint64(value)));
  else if (kind == "s" || kind == "o" || kind == "g") {
    gsize size;
    const char *text = g_variant_get_string(value, &size);
    check(size <= 8192 &&
          g_utf8_validate(text, static_cast<gssize>(size), nullptr));
    budget.bytes += size;
    check(budget.bytes <= max_bytes);
    data = string(env, std::string(text, size));
  } else
    throw Invalid();
  put(env, result, "value", data);
  return result;
}
napi_value body_to_js(napi_env env, GVariant *body, GUnixFDList *fds,
                      const OutputFd &retain) {
  if (!body) {
    napi_value empty;
    ok(napi_create_array(env, &empty));
    return empty;
  }
  body_signature(body);
  check(g_variant_get_size(body) <= max_bytes);
  size_t count = g_variant_n_children(body);
  check(count <= 32);
  napi_value result;
  ok(napi_create_array_with_length(env, count, &result));
  Budget budget;
  for (size_t i = 0; i < count; ++i) {
    Variant child(g_variant_get_child_value(body, i));
    ok(napi_set_element(env, result, static_cast<uint32_t>(i),
                        to_js(env, child.get(), 0, budget, fds, retain)));
  }
  return result;
}
} // namespace owbus
