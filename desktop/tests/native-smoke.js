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
    const tabs = Array.from(document.querySelectorAll("nav button"));
    if (tabs.length !== (state.preferences.setup_completed ? 5 : 6)) throw new Error("Missing navigation");
    for (const tab of tabs) {
      tab.click();
      await wait();
      const main = document.querySelector("main");
      if (
        !tab.classList.contains("selected") ||
        main.scrollWidth > main.clientWidth
      )
        throw new Error("Navigation or layout failed");
    }
    const icon = document.querySelector(".about-brand img");
    await document.fonts.ready;
    if (
      icon.naturalWidth !== 256 ||
      !Array.from(document.fonts).some(
        (font) =>
          font.family === "WhisperFree Inter" && font.status === "loaded",
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
