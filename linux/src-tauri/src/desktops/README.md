# Linux desktop integrations

| Directory | Responsibility | Implementation status |
| --- | --- | --- |
| `kde/` | GTK trigger capture, Qt key mapping, KGlobalAccel, KWin mouse leases and recovery | Native bindings implemented; distro acceptance remains tracked |
| `shared/` | XDG portals, clipboard helpers, session detection and overlay fallbacks | Used across Linux desktops according to available capabilities |
| `gnome/` | GNOME portal integration and acceptance boundary | Uses shared services; no native GNOME trigger adapter |
| `x11/` | X11 clipboard/window fallbacks and desktop acceptance boundary | Uses shared services; no general X11 trigger adapter |
| `wlroots/` | Sway/Hyprland capability and compositor binding boundary | Uses shared services; compositor acceptance remains open |

The common macOS/Linux web interface belongs to `shared/ui/` at the repository root.
Audio capture, inference recovery, storage and updates belong to the Linux host outside
this directory. Add native desktop-specific behavior to its adapter directory; keep
portable Linux services under `shared/`. See the root README and `docs/LINUX.md` for
build and validation instructions.
