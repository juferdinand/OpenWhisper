# Sway and Hyprland integration boundary

Sway and Hyprland use common Wayland clipboard and layer-shell paths where their services are available. Portal availability and compositor bindings must be validated separately. No compositor-specific native trigger adapter is implemented.

Acceptance is tracked in [Sway and Hyprland validation](https://github.com/juferdinand/OpenWhisper/issues/7). These directories document adapter ownership and remaining work; they do not claim tested distribution support. Keep additional native bindings here when they are implemented, and keep reusable portal code in `../shared/`.

Never run unattended input injection on the real desktop. Use owned test sessions and fields; record manual checks separately.
