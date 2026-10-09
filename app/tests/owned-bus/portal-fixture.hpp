// Synthetic portal frontend for the existing private D-Bus/audio runner.
// It never contacts a compositor, requests desktop access, or emits host input.
#include <algorithm>
#include <map>

static bool owned_portal_enabled = false;
static std::string owned_portal_mode = "grant", owned_portal_session;
static std::map<std::string, guint> owned_portal_objects;
static std::vector<guint> owned_portal_exports;
static const char owned_portal_xml[] = R"(<node>
<interface name='org.freedesktop.portal.GlobalShortcuts'>
<property name='version' type='u' access='read'/>
<method name='CreateSession'><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>
<method name='BindShortcuts'><arg type='o' direction='in'/><arg type='a(sa{sv})' direction='in'/><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>
<method name='ConfigureShortcuts'><arg type='o' direction='in'/><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/></method>
<signal name='Activated'><arg type='o'/><arg type='s'/><arg type='t'/><arg type='a{sv}'/></signal>
<signal name='Deactivated'><arg type='o'/><arg type='s'/><arg type='t'/><arg type='a{sv}'/></signal>
<signal name='ShortcutsChanged'><arg type='o'/><arg type='a(sa{sv})'/></signal>
</interface>
<interface name='org.freedesktop.host.portal.Registry'><method name='Register'><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/></method></interface>
<interface name='org.freedesktop.portal.Session'><method name='Close'/><signal name='Closed'><arg type='a{sv}'/></signal></interface>
<interface name='org.freedesktop.portal.Request'><method name='Close'/><signal name='Response'><arg type='u'/><arg type='a{sv}'/></signal></interface>
</node>)";
static GVariant *owned_empty_dict() {
  GVariantBuilder builder; g_variant_builder_init(&builder, G_VARIANT_TYPE("a{sv}"));
  return g_variant_builder_end(&builder);
}
static GVariant *owned_shortcuts(bool assigned) {
  GVariantBuilder list; g_variant_builder_init(&list, G_VARIANT_TYPE("a(sa{sv})"));
  if (assigned) {
    GVariantBuilder props; g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&props, "{sv}", "trigger_description", g_variant_new_string("Ctrl+Alt+Space"));
    g_variant_builder_add(&list, "(s@a{sv})", "dictate", g_variant_builder_end(&props));
  }
  return g_variant_builder_end(&list);
}
static void owned_portal_method(GDBusConnection *connection, const gchar *sender,
    const gchar *path, const gchar *, const gchar *member, GVariant *args,
    GDBusMethodInvocation *invocation, gpointer);
static GVariant *owned_portal_property(GDBusConnection *, const gchar *, const gchar *,
    const gchar *, const gchar *property, GError **, gpointer) {
  return g_str_equal(property, "version") ? g_variant_new_uint32(2) : nullptr;
}
static bool owned_portal_export(GDBusConnection *connection, const std::string &path, unsigned index) {
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(owned_portal_xml, nullptr);
  static const GDBusInterfaceVTable table{owned_portal_method, owned_portal_property, nullptr, {nullptr}};
  guint id = g_dbus_connection_register_object(connection, path.c_str(), info->interfaces[index], &table, nullptr, nullptr, nullptr);
  g_dbus_node_info_unref(info);
  if (!id) return false;
  owned_portal_exports.push_back(id);
  if (index >= 2) owned_portal_objects.emplace(path, id);
  return true;
}
static void owned_portal_method(GDBusConnection *connection, const gchar *sender,
    const gchar *path, const gchar *, const gchar *member, GVariant *args,
    GDBusMethodInvocation *invocation, gpointer) {
  if (g_str_equal(member, "Close")) {
    g_dbus_method_invocation_return_value(invocation, nullptr);
    auto found = owned_portal_objects.find(path);
    if (found != owned_portal_objects.end()) {
      const guint id = found->second;
      g_dbus_connection_unregister_object(connection, id); owned_portal_objects.erase(found);
      owned_portal_exports.erase(std::remove(owned_portal_exports.begin(), owned_portal_exports.end(), id), owned_portal_exports.end());
    }
    if (owned_portal_session == path) owned_portal_session.clear();
    return;
  }
  if (g_str_equal(member, "Register")) {
    const gchar *id; GVariant *options;
    g_variant_get(args, "(&s@a{sv})", &id, &options); g_variant_unref(options);
    if (!g_str_equal(id, "io.github.whisperfree.dev")) {
      g_dbus_method_invocation_return_dbus_error(invocation, "org.openwhisper.Owned.InvalidIdentity", "InvalidIdentity"); return;
    }
    g_dbus_method_invocation_return_value(invocation, nullptr); return;
  }
  if (g_str_equal(member, "ConfigureShortcuts")) {
    g_dbus_method_invocation_return_value(invocation, nullptr); return;
  }
  std::string peer = sender + 1; std::replace(peer.begin(), peer.end(), '.', '_');
  GVariant *options = g_variant_get_child_value(args, g_variant_n_children(args) - 1);
  const gchar *token = nullptr;
  if (!g_variant_lookup(options, "handle_token", "&s", &token)) {
    g_variant_unref(options); g_dbus_method_invocation_return_dbus_error(invocation, "org.openwhisper.Owned.InvalidToken", "InvalidToken"); return;
  }
  const std::string request = "/org/freedesktop/portal/desktop/request/" + peer + "/" + token;
  GVariantBuilder results; g_variant_builder_init(&results, G_VARIANT_TYPE("a{sv}"));
  if (g_str_equal(member, "CreateSession")) {
    const gchar *session_token = nullptr;
    if (!g_variant_lookup(options, "session_handle_token", "&s", &session_token)) {
      g_variant_unref(options); g_dbus_method_invocation_return_dbus_error(invocation, "org.openwhisper.Owned.InvalidToken", "InvalidToken"); return;
    }
    owned_portal_session = "/org/freedesktop/portal/desktop/session/" + peer + "/" + session_token;
    if (!owned_portal_export(connection, owned_portal_session, 2)) {
      g_variant_unref(options); g_dbus_method_invocation_return_dbus_error(invocation, "org.openwhisper.Owned.ExportFailed", "ExportFailed"); return;
    }
    g_variant_builder_add(&results, "{sv}", "session_handle", g_variant_new_string(owned_portal_session.c_str()));
  } else g_variant_builder_add(&results, "{sv}", "shortcuts", owned_shortcuts(true));
  g_variant_unref(options);
  if (g_str_equal(member, "BindShortcuts") && owned_portal_mode == "pending") {
    owned_portal_export(connection, request, 3); g_variant_builder_clear(&results);
  } else {
    // Deliberately signal before the method reply to exercise the subscription race.
    g_dbus_connection_emit_signal(connection, sender, request.c_str(), "org.freedesktop.portal.Request", "Response",
      g_variant_new("(u@a{sv})", owned_portal_mode == "deny" && g_str_equal(member, "BindShortcuts") ? 2U : 0U,
        g_variant_builder_end(&results)), nullptr);
  }
  g_dbus_method_invocation_return_value(invocation, g_variant_new("(o)", request.c_str()));
}
static bool owned_portal_control(GDBusConnection *connection, const gchar *member,
    GVariant *args, GDBusMethodInvocation *invocation) {
  if (!owned_portal_enabled) return false;
  if (g_str_equal(member, "PortalMode")) {
    const gchar *mode; g_variant_get(args, "(&s)", &mode);
    if (!g_str_equal(mode, "grant") && !g_str_equal(mode, "pending") && !g_str_equal(mode, "deny")) return false;
    owned_portal_mode = mode;
  } else if (g_str_equal(member, "PortalStatus")) {
    g_dbus_method_invocation_return_value(invocation, g_variant_new("(u)", static_cast<guint32>(owned_portal_objects.size()))); return true;
  } else if (g_str_equal(member, "Press") || g_str_equal(member, "Release")) {
    if (!owned_portal_session.empty()) g_dbus_connection_emit_signal(connection, nullptr,
      "/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts",
      g_str_equal(member, "Press") ? "Activated" : "Deactivated",
      g_variant_new("(ost@a{sv})", owned_portal_session.c_str(), "dictate",
        static_cast<guint64>(g_get_monotonic_time() / 1000), owned_empty_dict()), nullptr);
  } else if (g_str_equal(member, "Unassign")) {
    if (!owned_portal_session.empty()) g_dbus_connection_emit_signal(connection, nullptr,
      "/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts", "ShortcutsChanged",
      g_variant_new("(o@a(sa{sv}))", owned_portal_session.c_str(), owned_shortcuts(false)), nullptr);
  } else if (g_str_equal(member, "End")) {
    if (!owned_portal_session.empty()) g_dbus_connection_emit_signal(connection, nullptr, owned_portal_session.c_str(),
      "org.freedesktop.portal.Session", "Closed", g_variant_new("(@a{sv})", owned_empty_dict()), nullptr);
  } else return false;
  g_dbus_method_invocation_return_value(invocation, nullptr); return true;
}
static bool install_owned_portal(GDBusConnection *connection) {
  if (!owned_portal_export(connection, "/org/freedesktop/portal/desktop", 0) ||
      !owned_portal_export(connection, "/org/freedesktop/portal/desktop", 1)) return false;
  GVariant *reply = g_dbus_connection_call_sync(connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
    "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.freedesktop.portal.Desktop", 4),
    G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr, nullptr);
  if (!reply) return false;
  guint32 status; g_variant_get(reply, "(u)", &status); g_variant_unref(reply);
  owned_portal_enabled = status == 1; return owned_portal_enabled;
}
