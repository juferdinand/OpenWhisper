import type { MenuItemConstructorOptions } from "electron";
import type { AppState } from "../contracts/ui/state.js";

export interface TrayMenuActions {
  settings(): void;
  toggleRecording(): void;
  cancelRecording(): void;
  quit(): void;
}

export function buildTrayMenu(state: AppState, actions: TrayMenuActions,
  translate: (key: string) => string): readonly MenuItemConstructorOptions[] {
  const recording = state.status === "recording";
  const canStart = (state.status === "idle" || state.status === "done")
    && state.recording_available === true && !state.recovery_available;
  const canToggle = recording || canStart;
  const canCancel = recording || state.status === "transcribing";
  return [
    { id: "settings", label: translate("Settings …"), enabled: true, click: () => actions.settings() },
    { type: "separator" },
    { id: "toggle-recording", label: translate(recording ? "Stop recording" : "Start dictation"), enabled: canToggle,
      click: () => { if (canToggle) actions.toggleRecording(); } },
    { id: "cancel-recording", label: translate("Cancel"), enabled: canCancel,
      click: () => { if (canCancel) actions.cancelRecording(); } },
    { type: "separator" },
    { id: "quit", label: translate("Quit OpenWhisper"), enabled: true, click: () => actions.quit() },
  ];
}
