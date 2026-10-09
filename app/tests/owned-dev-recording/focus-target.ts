interface OwnedKwinWindow { readonly caption: string }
declare const workspace: {
  windowList?: () => OwnedKwinWindow[];
  clientList?: () => OwnedKwinWindow[];
  activeWindow?: OwnedKwinWindow;
  activeClient?: OwnedKwinWindow;
};

// Compiled for KWin's scripting API; only an owned fixture's exact caption is eligible.
const modern = typeof workspace.windowList === "function";
const windows = modern ? workspace.windowList?.() : workspace.clientList?.();
for (const window of windows ?? []) {
  if (window.caption !== "OpenWhisper Owned Typing Target") continue;
  if (modern) workspace.activeWindow = window;
  else workspace.activeClient = window;
}
