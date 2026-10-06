mod audio;
mod autostart;
mod desktops;
mod models;
mod relaunch;
mod settings;
mod smoke;
mod transcription;
mod updates;
mod worker;

use desktops::{
    kde,
    shared::{clipboard, overlay, portals, session},
};

use openwhisper_core::{catalog, Model};
use serde::Serialize;
use settings::{Paths, Preferences};
use std::{
    process::Child,
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
struct Snapshot {
    updates: updates::Snapshot,
    platform: String,
    version: String,
    status: String,
    message: String,
    transcript: String,
    history: Vec<String>,
    preferences: Preferences,
    models: Vec<Model>,
    installed: Vec<String>,
    microphones: Vec<String>,
    session: String,
    desktop: String,
    clipboard_available: bool,
    shortcut_portal: bool,
    paste_portal: bool,
    shortcut: Option<String>,
    native_shortcuts: bool,
    native_mouse: bool,
    native_middle_mouse: bool,
    recording_shortcut: bool,
    paste_ready: bool,
    gpu_available: bool,
    gpu_supported: bool,
    gpu_device: Option<String>,
    gpu_fallback: bool,
    recovery_available: bool,
    overlay_available: bool,
    download: Option<String>,
    progress: f64,
    elapsed: u64,
    level: f32,
    model_directory: String,
}

enum WorkerCommand {
    Toggle,
    Cancel,
    ShortcutPressed,
    ShortcutReleased,
    Retry,
    DiscardRecovery,
}

struct Runtime {
    autostart: autostart::Autostart,
    updater: updates::Service,
    triggers: kde::Service,
    tray_items: Mutex<Vec<tauri::menu::MenuItem<tauri::Wry>>>,
    state: Mutex<Snapshot>,
    app: tauri::AppHandle,
    paths: Paths,
    commands: mpsc::Sender<WorkerCommand>,
    clipboard: Mutex<Option<Child>>,
    paste: tokio::sync::Mutex<Option<portals::PasteSession>>,
    shortcut_task: tokio::sync::Mutex<Option<portals::ShortcutHandle>>,
    cancel_download: AtomicBool,
}
impl Runtime {
    fn update(&self, change: impl FnOnce(&mut Snapshot)) {
        let snapshot = {
            let mut state = self.state.lock().unwrap();
            change(&mut state);
            state.clone()
        };
        overlay::update(
            &self.app,
            &snapshot.status,
            snapshot.preferences.show_idle_overlay,
        );
        let _ = self.app.emit("state", snapshot);
    }
    fn error(&self, error: String) {
        self.update(|s| {
            s.status = "error".into();
            s.message = error;
        });
    }
    fn installed(&self) -> Vec<String> {
        catalog()
            .into_iter()
            .filter(|m| self.paths.models.join(&m.file).is_file())
            .map(|m| m.id)
            .collect()
    }
}

#[tauri::command]
fn get_state(runtime: tauri::State<'_, Arc<Runtime>>) -> Snapshot {
    let mut state = runtime.state.lock().unwrap();
    if let Ok(enabled) = runtime.autostart.enabled() {
        state.preferences.launch_at_login = enabled;
    }
    state.clone()
}
#[tauri::command]
fn toggle_recording(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    runtime
        .commands
        .send(WorkerCommand::Toggle)
        .map_err(|_| "Speech worker stopped".into())
}
#[tauri::command]
fn cancel_recording(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    runtime
        .commands
        .send(WorkerCommand::Cancel)
        .map_err(|_| "Speech worker stopped".into())
}
#[tauri::command]
fn retry_transcription(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    runtime
        .commands
        .send(WorkerCommand::Retry)
        .map_err(|_| "Speech worker stopped".into())
}
#[tauri::command]
fn discard_recovery(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    runtime
        .commands
        .send(WorkerCommand::DiscardRecovery)
        .map_err(|_| "Speech worker stopped".into())
}
#[tauri::command]
fn save_settings(
    runtime: tauri::State<'_, Arc<Runtime>>,
    preferences: Preferences,
) -> Result<Snapshot, String> {
    update_preferences(&runtime, |_| Ok(preferences))
}
#[tauri::command]
fn save_preferences(
    runtime: tauri::State<'_, Arc<Runtime>>,
    changes: serde_json::Map<String, serde_json::Value>,
) -> Result<Snapshot, String> {
    update_preferences(&runtime, |current| {
        let mut value = serde_json::to_value(current).map_err(|e| e.to_string())?;
        for (key, change) in changes {
            if !value.as_object().unwrap().contains_key(&key)
                || ["setup_completed", "gpu_configured", "native_trigger"].contains(&key.as_str())
            {
                return Err("Unknown or read-only preference".into());
            }
            value[&key] = change;
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    })
}
fn update_preferences(
    runtime: &Runtime,
    change: impl FnOnce(&Preferences) -> Result<Preferences, String>,
) -> Result<Snapshot, String> {
    // Merge against the current state under the same lock used for saving and history writes.
    let mut state = runtime.state.lock().unwrap();
    state.preferences.launch_at_login = runtime.autostart.enabled()?;
    let mut preferences = change(&state.preferences)?;
    preferences.setup_completed |= state.preferences.setup_completed;
    preferences.native_trigger = state.preferences.native_trigger.clone();
    runtime.paths.save(&preferences)?;
    if preferences.launch_at_login != state.preferences.launch_at_login {
        if let Err(error) = runtime.autostart.set(preferences.launch_at_login) {
            runtime.paths.save(&state.preferences)?;
            return Err(error);
        }
    }
    if !preferences.keep_history {
        runtime.paths.save_history(&[])?;
        state.history.clear();
    }
    state.preferences = preferences;
    state.message = "Settings saved on this device.".into();
    let snapshot = state.clone();
    drop(state);
    overlay::update(
        &runtime.app,
        &snapshot.status,
        snapshot.preferences.show_idle_overlay,
    );
    localize_tray(runtime, &snapshot.preferences.ui_language);
    let _ = runtime.app.emit("state", snapshot.clone());
    Ok(snapshot)
}
#[tauri::command]
fn complete_setup(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    let mut preferences = runtime.state.lock().unwrap().preferences.clone();
    preferences.setup_completed = true;
    save_settings(runtime, preferences).map(|_| ())
}
#[tauri::command]
fn refresh_microphones(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    let devices = audio::devices()?;
    runtime.update(|s| s.microphones = devices);
    Ok(())
}
#[tauri::command]
fn copy_transcript(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    let text = runtime.state.lock().unwrap().transcript.clone();
    if text.is_empty() {
        return Err("No transcript to copy".into());
    }
    clipboard::clipboard(&text, &mut runtime.clipboard.lock().unwrap())?;
    runtime.update(|s| s.message = "Transcript copied.".into());
    Ok(())
}
#[tauri::command]
fn clear_transcript(runtime: tauri::State<'_, Arc<Runtime>>) {
    runtime.update(|s| s.transcript.clear());
}
#[tauri::command]
fn clear_history(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    let mut state = runtime.state.lock().unwrap();
    runtime.paths.save_history(&[])?;
    state.history.clear();
    state.transcript.clear();
    let snapshot = state.clone();
    drop(state);
    let _ = runtime.app.emit("state", snapshot);
    Ok(())
}
#[tauri::command]
fn copy_history(runtime: tauri::State<'_, Arc<Runtime>>, index: usize) -> Result<(), String> {
    let text = runtime
        .state
        .lock()
        .unwrap()
        .history
        .get(index)
        .cloned()
        .ok_or("History item no longer available")?;
    clipboard::clipboard(&text, &mut runtime.clipboard.lock().unwrap())
}
#[tauri::command]
fn show_models_folder(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(&runtime.paths.models)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn enable_shortcut(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    if runtime.state.lock().unwrap().native_shortcuts {
        kde::begin_capture(runtime.inner().clone()).await
    } else {
        portals::enable_shortcut(runtime.inner().clone()).await
    }
}
#[tauri::command]
async fn enable_paste(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    portals::enable_paste(runtime.inner()).await
}
#[tauri::command]
async fn disable_paste(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    portals::disable_paste(runtime.inner()).await;
    Ok(())
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments
        .get(1)
        .is_some_and(|a| a == "--transcription-smoke-test")
    {
        let result = transcription::smoke_test(&arguments);
        if let Err(error) = result.as_ref() {
            eprintln!("Transcription check failed: {error}");
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if std::env::args().any(|arg| arg == "--linux-speech-helper") {
        let result = transcription::helper();
        // The parent reports errors; private inference data never goes to logs.
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if std::env::args().any(|arg| arg == "--linux-trigger-helper") {
        std::process::exit(desktops::kde::helper::run());
    }
    let _smoke_environment = smoke::Environment::prepare();
    gtk::glib::set_prgname(Some("io.github.whisperfree"));
    gtk::glib::set_application_name("OpenWhisper");
    // WebKitGTK's DMABUF path can disconnect NVIDIA clients from KWin (WebKit bug 324551).
    // Set this before GTK or any worker starts; leave an explicit user override intact.
    if session::wayland()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    if std::env::args().any(|arg| arg == "--diagnose") {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (shortcut, paste) = rt.block_on(async {
            (
                ashpd::desktop::global_shortcuts::GlobalShortcuts::new()
                    .await
                    .map(|p| p.version())
                    .ok(),
                ashpd::desktop::remote_desktop::RemoteDesktop::new()
                    .await
                    .map(|p| p.version())
                    .ok(),
            )
        });
        println!(
            "{}",
            serde_json::json!({"session": if session::wayland() {"Wayland"} else {"X11"},
            "desktop": std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(), "microphones": audio::devices(),
            "global_shortcuts_portal": shortcut, "remote_desktop_portal": paste, "vulkan_build": cfg!(feature="vulkan"),
            "clipboard_helper": session::available(if session::wayland() {"wl-copy"} else {"xclip"})})
        );
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_state,
            toggle_recording,
            cancel_recording,
            retry_transcription,
            discard_recovery,
            save_settings,
            save_preferences,
            complete_setup,
            updates::check_updates,
            updates::install_update,
            refresh_microphones,
            copy_transcript,
            clear_transcript,
            clear_history,
            copy_history,
            show_models_folder,
            enable_shortcut,
            kde::cancel_shortcut,
            kde::clear_shortcut,
            kde::desktop_shortcut,
            enable_paste,
            disable_paste,
            models::download_model,
            models::cancel_download,
            smoke::complete,
            smoke::reactivate
        ])
        .on_page_load(|webview, payload| {
            if smoke::enabled()
                && webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                let _ = webview.eval(include_str!("../../tests/native-smoke.js"));
            }
        })
        .setup(|app| {
            // GTK launcher activation emits Ready again in Tao. Create the configured window
            // only in this one-shot setup hook, so reactivation cannot create a duplicate label.
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?.build()?;
            if let Some(window) = app.get_webview_window("main") {
                use gtk::prelude::*;
                let native = window.gtk_window()?;
                native.set_icon_name(Some("io.github.whisperfree"));
                if let Some(application) = native.application() {
                    // A launcher activation must also reopen a window previously hidden to the tray.
                    application.connect_activate(move |_| {
                        let _ = window.show();
                        let _ = window.unminimize();
                        native.present();
                    });
                }
            }
            if smoke::enabled() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(30));
                    eprintln!("Native UI smoke test timed out");
                    handle.exit(1);
                });
            }
            let overlay_available = overlay::create(app).unwrap_or_else(|error| {
                eprintln!("Floating recording indicator unavailable: {error}");
                false
            });
            let paths = Paths::new()?;
            let autostart = autostart::Autostart::new(app.handle())?;
            let (mut preferences, message) = match paths.load() {
                Ok(p) => (p, "Choose a model, then make yourself heard.".into()),
                Err(e) => (Preferences::default(), e),
            };
            preferences.launch_at_login = autostart.enabled().unwrap_or(false);
            let installed = catalog()
                .into_iter()
                .filter(|m| paths.models.join(&m.file).is_file())
                .map(|m| m.id)
                .collect();
            let history = if preferences.keep_history {
                paths.load_history().unwrap_or_default()
            } else {
                vec![]
            };
            let (commands, receiver) = mpsc::channel();
            let state = Arc::new(Runtime {
                autostart,
                updater: updates::Service::default(),
                triggers: kde::Service::default(),
                tray_items: Mutex::new(vec![]),
                state: Mutex::new(Snapshot {
                    updates: updates::Snapshot::new(app.handle()),
                    platform: "linux".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                    status: "idle".into(),
                    message,
                    transcript: String::new(),
                    history,
                    preferences,
                    models: catalog(),
                    installed,
                    microphones: audio::devices().unwrap_or_default(),
                    session: if session::wayland() { "Wayland" } else { "X11" }.into(),
                    desktop: std::env::var("XDG_CURRENT_DESKTOP")
                        .unwrap_or_else(|_| "Unknown desktop".into()),
                    clipboard_available: session::available(if session::wayland() {
                        "wl-copy"
                    } else {
                        "xclip"
                    }),
                    shortcut_portal: false,
                    paste_portal: false,
                    shortcut: None,
                    native_shortcuts: false,
                    native_mouse: false,
                    native_middle_mouse: false,
                    recording_shortcut: false,
                    paste_ready: false,
                    gpu_available: false,
                    gpu_supported: cfg!(feature = "vulkan"),
                    gpu_device: None,
                    gpu_fallback: false,
                    recovery_available: false,
                    overlay_available,
                    download: None,
                    progress: 0.0,
                    elapsed: 0,
                    level: 0.0,
                    model_directory: paths.models.to_string_lossy().into_owned(),
                }),
                app: app.handle().clone(),
                paths,
                commands,
                clipboard: Mutex::new(None),
                paste: tokio::sync::Mutex::new(None),
                shortcut_task: tokio::sync::Mutex::new(None),
                cancel_download: AtomicBool::new(false),
            });
            app.manage(state.clone());
            updates::start(state.clone());
            kde::install_capture(state.clone())?;
            tauri::async_runtime::spawn(kde::initialize(state.clone()));
            let worker = state.clone();
            std::thread::Builder::new()
                .name("speech-worker".into())
                .spawn(move || worker::run(worker, receiver))?;
            tauri::async_runtime::spawn(async move {
                let shortcuts = ashpd::desktop::global_shortcuts::GlobalShortcuts::new()
                    .await
                    .is_ok();
                let paste = ashpd::desktop::remote_desktop::RemoteDesktop::new()
                    .await
                    .is_ok();
                state.update(|s| {
                    s.shortcut_portal = shortcuts;
                    s.paste_portal = paste;
                });
            });
            let show = tauri::menu::MenuItem::with_id(
                app,
                "show",
                "Open OpenWhisper",
                true,
                None::<&str>,
            )?;
            let record = tauri::menu::MenuItem::with_id(
                app,
                "record",
                "Start / stop dictation",
                true,
                None::<&str>,
            )?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &record, &quit])?;
            let tray = tauri::tray::TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenWhisper — local dictation")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "record" => {
                        let _ = app
                            .state::<Arc<Runtime>>()
                            .commands
                            .send(WorkerCommand::Toggle);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app);
            let runtime = app.state::<Arc<Runtime>>();
            *runtime.tray_items.lock().unwrap() = vec![show, record, quit];
            let locale = runtime
                .state
                .lock()
                .unwrap()
                .preferences
                .ui_language
                .clone();
            localize_tray(&runtime, &locale);
            if tray.is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    let w = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = w.hide();
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start OpenWhisper");
    // Capture the permanent executable before an update replaces it. For .deb installs,
    // current_exe() would otherwise refer to the old, deleted inode after dpkg finishes.
    let relaunch = Arc::new(relaunch::Relaunch::new(
        tauri::process::current_binary(&app.env()).map_err(|e| e.to_string()),
        app.env().args_os.into_iter().skip(1).collect(),
    ));
    app.manage(relaunch.clone());
    let exit_code = app.run_return(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = app.try_state::<Arc<Runtime>>() {
                tauri::async_runtime::block_on(kde::shutdown(&state));
                if let Some(mut child) = state.clipboard.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
    std::process::exit(relaunch.finish(exit_code));
}

fn localize_tray(runtime: &Runtime, locale: &str) {
    static GERMAN: std::sync::OnceLock<std::collections::HashMap<String, String>> =
        std::sync::OnceLock::new();
    let german = GERMAN.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/locales/de.json"))
            .expect("Valid translations")
    });
    for (item, label) in runtime.tray_items.lock().unwrap().iter().zip([
        "Open OpenWhisper",
        "Start / stop dictation",
        "Quit",
    ]) {
        let text = if locale == "de" {
            german.get(label).map(String::as_str).unwrap_or(label)
        } else {
            label
        };
        let _ = item.set_text(text);
    }
}
