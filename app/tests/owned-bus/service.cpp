// Owned fixture only: exercises actual D-Bus FD/signature/lifetime behavior.
#include <cstring>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <glib-unix.h>
#include <string>
#include <sys/mman.h>
#include <unistd.h>
#include <vector>

static GMainLoop *loop;
static std::vector<GDBusMethodInvocation *> held;
static const char xml[] = R"(<node><interface name='org.openwhisper.Owned'>
<method name='Echo'><arg type='x' direction='in'/><arg type='t' direction='in'/><arg type='a{sv}' direction='in'/><arg type='a(su)' direction='in'/><arg type='x' direction='out'/><arg type='t' direction='out'/><arg type='a{sv}' direction='out'/><arg type='a(su)' direction='out'/></method>
<method name='Fd'><arg type='s' direction='in'/><arg type='h' direction='out'/></method>
<method name='ReflectFd'><arg type='h' direction='in'/><arg type='u' direction='out'/></method>
<method name='Wrong'><arg type='u' direction='out'/></method>
<method name='Hold'/><method name='Emit'/><method name='Burst'/><method name='Huge'/><signal name='Changed'><arg type='s'/></signal>
</interface></node>)";
static void method(GDBusConnection *connection, const gchar *, const gchar *,
                   const gchar *, const gchar *member, GVariant *args,
                   GDBusMethodInvocation *invocation, gpointer) {
  if (!(g_dbus_message_get_flags(
            g_dbus_method_invocation_get_message(invocation)) &
        G_DBUS_MESSAGE_FLAGS_NO_AUTO_START)) {
    g_dbus_method_invocation_return_dbus_error(
        invocation, "org.openwhisper.Owned.ActivationRefused",
        "ActivationRefused");
    return;
  }
  if (g_str_equal(member, "Echo")) {
    g_dbus_method_invocation_return_value(invocation, args);
    return;
  }
  if (g_str_equal(member, "Wrong")) {
    g_dbus_method_invocation_return_value(invocation, g_variant_new("(u)", 7));
    return;
  }
  if (g_str_equal(member, "Hold")) {
    if (held.size() >= 16)
      g_dbus_method_invocation_return_dbus_error(
          invocation, "org.openwhisper.Owned.Busy", "Busy");
    else
      held.push_back(G_DBUS_METHOD_INVOCATION(g_object_ref(invocation)));
    return;
  }
  if (g_str_equal(member, "Emit")) {
    g_dbus_connection_emit_signal(connection, nullptr, "/owned",
                                  "org.openwhisper.Owned", "Changed",
                                  g_variant_new("(s)", "metadata"), nullptr);
    g_dbus_method_invocation_return_value(invocation, nullptr);
    return;
  }
  if (g_str_equal(member, "Burst") || g_str_equal(member, "Huge")) {
    const bool huge = g_str_equal(member, "Huge");
    std::string content(huge ? 70000 : 8, 'x');
    for (int i = 0; i < (huge ? 1 : 256); ++i)
      g_dbus_connection_emit_signal(
          connection, nullptr, "/owned", "org.openwhisper.Owned", "Changed",
          g_variant_new("(s)", content.c_str()), nullptr);
    g_dbus_method_invocation_return_value(invocation, nullptr);
    return;
  }
  if (g_str_equal(member, "ReflectFd")) {
    GUnixFDList *list = g_dbus_message_get_unix_fd_list(
        g_dbus_method_invocation_get_message(invocation));
    gint handle;
    g_variant_get(args, "(h)", &handle);
    int fd = list ? g_unix_fd_list_get(list, handle, nullptr) : -1;
    char bytes[64];
    ssize_t count = fd >= 0 ? pread(fd, bytes, sizeof(bytes), 0) : -1;
    if (fd >= 0)
      close(fd);
    if (count < 0)
      g_dbus_method_invocation_return_dbus_error(
          invocation, "org.openwhisper.Owned.Invalid", "Invalid");
    else
      g_dbus_method_invocation_return_value(
          invocation, g_variant_new("(u)", static_cast<guint32>(count)));
    return;
  }
  if (g_str_equal(member, "Fd")) {
    const gchar *mode;
    g_variant_get(args, "(&s)", &mode);
    int fd = -1;
    if (g_str_equal(mode, "pipe")) {
      int ends[2];
      if (pipe(ends) == 0) {
        fd = ends[0];
        close(ends[1]);
      }
    } else {
      fd = memfd_create("owned-metadata", MFD_CLOEXEC);
      if (fd >= 0) {
        constexpr char text[] = "owned-fd-metadata";
        if (write(fd, text, sizeof(text) - 1) != sizeof(text) - 1) {
          close(fd);
          fd = -1;
        } else if (g_str_equal(mode, "large") && ftruncate(fd, 2097152) < 0) {
          close(fd);
          fd = -1;
        }
      }
    }
    if (fd < 0) {
      g_dbus_method_invocation_return_dbus_error(
          invocation, "org.openwhisper.Owned.Invalid", "Invalid");
      return;
    }
    GUnixFDList *list = g_unix_fd_list_new();
    int index = g_unix_fd_list_append(list, fd, nullptr);
    close(fd);
    if (g_str_equal(mode, "extra")) {
      int extra = memfd_create("owned-unused", MFD_CLOEXEC);
      if (extra >= 0) {
        g_unix_fd_list_append(list, extra, nullptr);
        close(extra);
      }
    }
    g_dbus_method_invocation_return_value_with_unix_fd_list(
        invocation, g_variant_new("(h)", g_str_equal(mode, "bad") ? 9 : index),
        list);
    g_object_unref(list);
    return;
  }
  g_dbus_method_invocation_return_dbus_error(
      invocation, "org.openwhisper.Owned.Unknown", "Unknown");
}
int main(int argc, char **argv) {
  if ((argc != 2 && argc != 4) || getuid() == 0)
    return 1;
  GError *error = nullptr;
  auto *connection = g_dbus_connection_new_for_address_sync(
      argv[1],
      static_cast<GDBusConnectionFlags>(
          G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
          G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
      nullptr, nullptr, &error);
  if (!connection) {
    g_print("FIXTURE_CONNECT_FAILED:%u\n",
            error ? static_cast<unsigned int>(error->code) : 0);
    if (error)
      g_error_free(error);
    return 2;
  }
  g_dbus_connection_set_exit_on_close(connection, FALSE);
  if (argc == 4) {
    if (!g_str_equal(argv[2], "foreign-control") || getuid() != 1001 ||
        !g_dbus_is_unique_name(argv[3]))
      return 6;
    GVariant *response = g_dbus_connection_call_sync(
        connection, argv[3], "/io/github/whisperfree/dev/Control",
        "io.github.whisperfree.Control1", "Status", nullptr,
        G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr,
        &error);
    gchar *name = error ? g_dbus_error_get_remote_error(error) : nullptr;
    const bool denied = !response && name &&
                        g_str_equal(name, "io.github.whisperfree.Error.Denied");
    if (response)
      g_variant_unref(response);
    if (name)
      g_free(name);
    if (error)
      g_error_free(error);
    g_dbus_connection_close_sync(connection, nullptr, nullptr);
    g_object_unref(connection);
    if (denied)
      g_print("FOREIGN_UID_DENIED:1001\n");
    return denied ? 0 : 7;
  }
  auto *info = g_dbus_node_info_new_for_xml(xml, &error);
  if (!info)
    return 3;
  static const GDBusInterfaceVTable table{method, nullptr, nullptr, {nullptr}};
  guint exported = g_dbus_connection_register_object(
      connection, "/owned", info->interfaces[0], &table, nullptr, nullptr,
      &error);
  g_dbus_node_info_unref(info);
  if (!exported)
    return 4;
  auto *reply = g_dbus_connection_call_sync(
      connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "RequestName",
      g_variant_new("(su)", "org.openwhisper.Owned.Test", 4),
      G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr,
      &error);
  if (!reply)
    return 5;
  g_variant_unref(reply);
  loop = g_main_loop_new(nullptr, FALSE);
  g_unix_signal_add(
      SIGTERM,
      [](gpointer) -> gboolean {
        g_main_loop_quit(loop);
        return G_SOURCE_REMOVE;
      },
      nullptr);
  g_main_loop_run(loop);
  for (auto *invocation : held) {
    g_dbus_method_invocation_return_dbus_error(
        invocation, "org.openwhisper.Owned.Closed", "Closed");
    g_object_unref(invocation);
  }
  g_dbus_connection_unregister_object(connection, exported);
  g_dbus_connection_close_sync(connection, nullptr, nullptr);
  g_object_unref(connection);
  g_main_loop_unref(loop);
  return 0;
}
