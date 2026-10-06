pub fn enabled() -> bool {
    std::env::args().any(|arg| arg == "--ui-smoke-test")
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
            "Native UI smoke test passed: native IPC, six tabs, original icon, and bundled font."
        );
        app.exit(0);
    }
    Ok(())
}
