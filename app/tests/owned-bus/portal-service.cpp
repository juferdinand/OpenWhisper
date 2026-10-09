// Private fixture only; reuse the owned bus service conventions without changing retained inputs.
#include <gio/gio.h>
#include <glib-unix.h>
#include <string>
#include <unistd.h>
#include <vector>
#include "portal-fixture.hpp"

static const char controls[] = R"(<node><interface name='org.openwhisper.Owned'>
<method name='PortalMode'><arg type='s' direction='in'/></method><method name='PortalStatus'><arg type='u' direction='out'/></method>
<method name='Press'/><method name='Release'/><method name='Unassign'/><method name='End'/>
</interface></node>)";
static void control(GDBusConnection *connection, const gchar *, const gchar *, const gchar *,
    const gchar *member, GVariant *args, GDBusMethodInvocation *invocation, gpointer) {
  if (!owned_portal_control(connection, member, args, invocation))
    g_dbus_method_invocation_return_dbus_error(invocation, "org.openwhisper.Owned.Unknown", "Unknown");
}
int main(int argc, char **argv) {
  if (argc != 2 || getuid() == 0) return 1;
  GDBusConnection *connection = g_dbus_connection_new_for_address_sync(argv[1],
    static_cast<GDBusConnectionFlags>(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
    nullptr, nullptr, nullptr);
  if (!connection) return 2;
  g_dbus_connection_set_exit_on_close(connection, FALSE);
  if (!install_owned_portal(connection)) return 3;
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(controls, nullptr);
  static const GDBusInterfaceVTable table{control, nullptr, nullptr, {nullptr}};
  guint id = g_dbus_connection_register_object(connection, "/owned", info->interfaces[0], &table, nullptr, nullptr, nullptr);
  g_dbus_node_info_unref(info); if (!id) return 4;
  GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
  g_unix_signal_add(SIGTERM, [](gpointer pointer) -> gboolean {
    g_main_loop_quit(static_cast<GMainLoop *>(pointer)); return G_SOURCE_REMOVE;
  }, loop);
  g_main_loop_run(loop);
  g_dbus_connection_unregister_object(connection, id);
  for (guint exported : owned_portal_exports) g_dbus_connection_unregister_object(connection, exported);
  g_dbus_connection_close_sync(connection, nullptr, nullptr); g_object_unref(connection); g_main_loop_unref(loop);
  return 0;
}
