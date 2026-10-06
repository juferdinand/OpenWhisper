use gtk::prelude::*;
use tauri::Manager;

pub fn enabled() -> bool {
    std::env::args().any(|arg| arg == "--ui-smoke-test")
}

/// Native smoke checks include autostart writes, so always isolate them from real preferences.
pub struct Environment(std::path::PathBuf);
impl Environment {
    pub fn prepare() -> Option<Self> {
        if !enabled() {
            return None;
        }
        let root = std::env::temp_dir().join(format!("openwhisper-smoke-{}", uuid::Uuid::new_v4()));
        for (variable, folder) in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data")] {
            let path = root.join(folder);
            std::fs::create_dir_all(&path)
                .expect("Could not create isolated smoke-test directories");
            // Called at process entry, before GTK or worker threads exist.
            std::env::set_var(variable, path);
        }
        Some(Self(root))
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
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
            "Native UI smoke test passed: native IPC, onboarding completion, language persistence, original icon, bundled font, and GTK reactivation."
        );
        app.exit(0);
    }
    Ok(())
}
