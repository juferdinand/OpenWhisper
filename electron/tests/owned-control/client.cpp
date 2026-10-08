#include <cstring>
#include <gio/gio.h>
#include <iostream>

// Owned OS fixture only: a real independent bus client with deterministic
// exits.
int main(int argc, char **argv) {
  if (argc != 5)
    return 2;
  GError *error = nullptr;
  GDBusConnection *bus = g_dbus_connection_new_for_address_sync(
      argv[1],
      static_cast<GDBusConnectionFlags>(
          G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
          G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
      nullptr, nullptr, &error);
  if (!bus) {
    if (error)
      g_error_free(error);
    return 3;
  }
  if (std::strcmp(argv[3], "no-reply") == 0) {
    GDBusMessage *message = g_dbus_message_new_method_call(
        argv[2], "/io/github/whisperfree/dev/Control",
        "io.github.whisperfree.Control1", "Execute");
    g_dbus_message_set_flags(
        message,
        static_cast<GDBusMessageFlags>(G_DBUS_MESSAGE_FLAGS_NO_REPLY_EXPECTED |
                                       G_DBUS_MESSAGE_FLAGS_NO_AUTO_START));
    g_dbus_message_set_body(message, g_variant_new("(s)", argv[4]));
    const gboolean queued = g_dbus_connection_send_message(
        bus, message, G_DBUS_SEND_MESSAGE_FLAGS_NONE, nullptr, &error);
    g_object_unref(message);
    if (queued)
      g_dbus_connection_flush_sync(bus, nullptr, nullptr);
    g_dbus_connection_close_sync(bus, nullptr, nullptr);
    g_object_unref(bus);
    if (error)
      g_error_free(error);
    if (!queued)
      return 4;
    std::cout << "NO_REPLY_QUEUED\n";
    return 0;
  }
  const bool status = std::strcmp(argv[4], "status") == 0;
  GVariant *reply = g_dbus_connection_call_sync(
      bus, argv[2], "/io/github/whisperfree/dev/Control",
      "io.github.whisperfree.Control1", status ? "Status" : "Execute",
      status ? g_variant_new("()") : g_variant_new("(s)", argv[4]),
      G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 5000, nullptr,
      &error);
  // Close immediately after receiving the accepted reply, before printing.
  g_dbus_connection_close_sync(bus, nullptr, nullptr);
  g_object_unref(bus);
  if (!reply) {
    gchar *name = error ? g_dbus_error_get_remote_error(error) : nullptr;
    const bool denied =
        name && std::strcmp(name, "io.github.whisperfree.Error.Denied") == 0;
    if (name)
      g_free(name);
    if (error)
      g_error_free(error);
    if (std::strcmp(argv[3], "foreign") == 0 && denied) {
      std::cout << "FOREIGN_UID_DENIED:1001\n";
      return 0;
    }
    std::cout << "REFUSED\n";
    return 5;
  }
  const gchar *result = nullptr;
  g_variant_get(reply, "(&s)", &result);
  if (!result ||
      (std::strcmp(result, "idle") && std::strcmp(result, "recording") &&
       std::strcmp(result, "transcribing") &&
       std::strcmp(result, "unavailable"))) {
    g_variant_unref(reply);
    return 6;
  }
  std::cout << "ACCEPTED:" << result << '\n';
  g_variant_unref(reply);
  return 0;
}
