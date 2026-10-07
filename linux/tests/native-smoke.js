function assertNativeSmokeLayout(main, tab) {
  if (!main || !tab.isConnected || !tab.classList.contains("selected"))
    throw new Error("Navigation failed");

  const bounds = main.getBoundingClientRect();
  const style = getComputedStyle(main);
  const borderLeft = parseFloat(style.borderLeftWidth);
  const borderRight = parseFloat(style.borderRightWidth);
  const gutter = Math.max(0, main.offsetWidth - main.clientWidth - borderLeft - borderRight);
  const left = bounds.left + borderLeft;
  const right = bounds.right - borderRight - gutter;
  for (const child of main.querySelectorAll("*")) {
    if (!child.getClientRects().length || getComputedStyle(child).visibility !== "visible") continue;
    const childBounds = child.getBoundingClientRect();
    if (childBounds.left < left || childBounds.right > right)
      throw new Error("Visible settings content exceeds its viewport");
  }

  const overflow = main.scrollWidth - main.clientWidth;
  // WebKit bug 268275: fractional zoom can round these integer getters differently.
  // GTK font-DPI scaling can leave devicePixelRatio at 1 in bundled WebKit.
  // Require the measured fractional viewport/root mismatch and contained geometry.
  const fractionalRounding = overflow === 1 &&
    !Number.isInteger(bounds.width) && document.documentElement.clientWidth - innerWidth === 1;
  if (overflow > 0 && !fractionalRounding)
    throw new Error("Settings layout overflows horizontally");
}

// Executed only when the native Linux binary starts with --ui-smoke-test.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    for (
      let attempt = 0;
      attempt < 150 && document.documentElement.dataset.ready !== "true";
      attempt++
    )
      await wait();
    const state = await invoke("get_state");
    if (
      state.platform !== "linux" ||
      document.documentElement.dataset.ready !== "true"
    )
      throw new Error("Native state did not reach the UI");
    // The smoke-test process runs with isolated XDG directories, never the user's autostart.
    const first = await invoke("save_preferences", { changes: { launch_at_login: true } });
    if (!first.preferences.launch_at_login || first.preferences.show_idle_overlay !== state.preferences.show_idle_overlay)
      throw new Error("Launch at login changed the idle overlay");
    const second = await invoke("save_preferences", { changes: { show_idle_overlay: true } });
    if (!second.preferences.launch_at_login || !second.preferences.show_idle_overlay)
      throw new Error("Preference patches overwrote another setting");
    const third = await invoke("save_preferences", { changes: { launch_at_login: false, show_idle_overlay: state.preferences.show_idle_overlay } });
    if (third.preferences.launch_at_login) throw new Error("Launch at login could not be disabled");
    const tabs = Array.from(document.querySelectorAll("nav button"));
    if (tabs.length !== (state.preferences.setup_completed ? 5 : 6)) throw new Error("Missing navigation");
    for (const tab of tabs) {
      tab.click();
      await wait();
      const main = document.querySelector("main");
      assertNativeSmokeLayout(main, tab);
    }
    const icon = document.querySelector(".about-brand img");
    await document.fonts.ready;
    if (
      icon.naturalWidth !== 256 ||
      !Array.from(document.fonts).some(
        (font) =>
          font.family === "OpenWhisper Inter" && font.status === "loaded",
      )
    )
      throw new Error("Bundled branding failed to load");
    document.querySelector('[data-ui-language="de"]').click();
    await wait(); await wait();
    if ((await invoke("get_state")).preferences.ui_language !== "de" || document.documentElement.lang !== "de")
      throw new Error("Language did not persist through native IPC");
    await invoke("complete_setup");
    await wait();
    if (!(await invoke("get_state")).preferences.setup_completed || document.querySelector('[data-tab="setup"]'))
      throw new Error("Completed onboarding is still visible");
    document.querySelector('[data-ui-language="en"]').click();
    await wait();
    await invoke("reactivate");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await invoke("get_state");
    await invoke("complete", { error: null });
  } catch (error) {
    await invoke("complete", { error: String(error) });
  }
})();
