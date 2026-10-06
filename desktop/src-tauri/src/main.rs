mod audio;
mod integration;
mod models;
mod overlay;
mod settings;
mod smoke;
mod worker;

use serde::Serialize;
use settings::{Paths, Preferences};
use std::{
    process::Child,
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex},
};
use tauri::{Emitter, Manager};
use whisperfree_core::{catalog, Model};

#[derive(Clone, Serialize)]
struct Snapshot {
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
    paste_ready: bool,
    gpu_available: bool,
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
}

struct Runtime {
    state: Mutex<Snapshot>,
    app: tauri::AppHandle,
    paths: Paths,
    commands: mpsc::Sender<WorkerCommand>,
    clipboard: Mutex<Option<Child>>,
    paste: tokio::sync::Mutex<Option<integration::PasteSession>>,
    shortcut_task: tokio::sync::Mutex<Option<integration::ShortcutHandle>>,
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
    runtime.state.lock().unwrap().clone()
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
fn save_settings(
    runtime: tauri::State<'_, Arc<Runtime>>,
    preferences: Preferences,
) -> Result<(), String> {
    // Serialize history removal with the worker's writes when opting out.
    let mut state = runtime.state.lock().unwrap();
    runtime.paths.save(&preferences)?;
    if !preferences.keep_history {
        runtime.paths.save_history(&[])?;
    }
    if !preferences.keep_history {
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
    let _ = runtime.app.emit("state", snapshot);
    Ok(())
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
    integration::clipboard(&text, &mut runtime.clipboard.lock().unwrap())?;
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
    integration::clipboard(&text, &mut runtime.clipboard.lock().unwrap())
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
    integration::enable_shortcut(runtime.inner().clone()).await
}
#[tauri::command]
async fn enable_paste(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    integration::enable_paste(runtime.inner()).await
}
#[tauri::command]
async fn disable_paste(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    integration::disable_paste(runtime.inner()).await;
    Ok(())
}

fn main() {
    gtk::glib::set_prgname(Some("io.github.whisperfree"));
    gtk::glib::set_application_name("WhisperFree");
    // WebKitGTK's DMABUF path can disconnect NVIDIA clients from KWin (WebKit bug 324551).
    // Set this before GTK or any worker starts; leave an explicit user override intact.
    if integration::wayland()
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
            serde_json::json!({"session": if integration::wayland() {"Wayland"} else {"X11"},
            "desktop": std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(), "microphones": audio::devices(),
            "global_shortcuts_portal": shortcut, "remote_desktop_portal": paste, "vulkan_build": cfg!(feature="vulkan"),
            "clipboard_helper": integration::available(if integration::wayland() {"wl-copy"} else {"xclip"})})
        );
        return;
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_state,
            toggle_recording,
            cancel_recording,
            save_settings,
            refresh_microphones,
            copy_transcript,
            clear_transcript,
            clear_history,
            copy_history,
            show_models_folder,
            enable_shortcut,
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
            let (preferences, message) = match paths.load() {
                Ok(p) => (p, "Choose a model, then make yourself heard.".into()),
                Err(e) => (Preferences::default(), e),
            };
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
                state: Mutex::new(Snapshot {
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
                    session: if integration::wayland() {
                        "Wayland"
                    } else {
                        "X11"
                    }
                    .into(),
                    desktop: std::env::var("XDG_CURRENT_DESKTOP")
                        .unwrap_or_else(|_| "Unknown desktop".into()),
                    clipboard_available: integration::available(if integration::wayland() {
                        "wl-copy"
                    } else {
                        "xclip"
                    }),
                    shortcut_portal: false,
                    paste_portal: false,
                    shortcut: None,
                    paste_ready: false,
                    gpu_available: cfg!(feature = "vulkan"),
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
                "Open WhisperFree",
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
                .tooltip("WhisperFree — local dictation")
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
        .expect("Could not start WhisperFree")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<Arc<Runtime>>() {
                    if let Some(mut child) = state.clipboard.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
