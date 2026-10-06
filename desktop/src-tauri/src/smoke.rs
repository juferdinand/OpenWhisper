use gtk::prelude::*;
use tauri::Manager;

pub fn enabled() -> bool {
    std::env::args().any(|arg| arg == "--ui-smoke-test")
}

#[tauri::command]
pub fn reactivate(app: tauri::AppHandle) -> Result<(), String> {
    if !enabled() {
        return Err("Test mode is not enabled".into());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let window = handle.get_webview_window("main").unwrap();
        let native = window.gtk_window().unwrap();
        let _ = window.hide();
        native.application().unwrap().activate();
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn complete(app: tauri::AppHandle, error: Option<String>) -> Result<(), String> {
    if !enabled() {
        return Err("Test mode is not enabled".into());
    }
    if let Some(error) = error {
        eprintln!("Native UI smoke test failed: {error}");
        app.exit(1);
    } else {
        println!(
            "Native UI smoke test passed: native IPC, six tabs, original icon, bundled font, and GTK reactivation."
        );
        app.exit(0);
    }
    Ok(())
}
