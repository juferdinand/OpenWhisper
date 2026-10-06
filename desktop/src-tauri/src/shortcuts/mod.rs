mod capture;
pub mod helper;
mod kde;
mod trigger;

use crate::{Runtime, WorkerCommand};
use std::{
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};
pub use trigger::Trigger;

#[derive(Default)]
pub struct Service {
    operation: tokio::sync::Mutex<()>,
    active: tokio::sync::Mutex<Option<Running>>,
    capture: Mutex<capture::Capture>,
    closing: AtomicBool,
}
struct Running {
    child: Child,
    events: tauri::async_runtime::JoinHandle<()>,
    stopping: Arc<AtomicBool>,
}
impl Running {
    async fn stop(&mut self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Relaxed);
        drop(self.child.stdin.take());
        let _status = tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .map_err(|_| {
                "The trigger helper is still restoring the desktop settings. Try again shortly."
            })?
            .map_err(|e| e.to_string())?;
        self.events.abort();
        Ok(())
    }
}
async fn stop_active(runtime: &Runtime) -> Result<(), String> {
    let mut active = runtime.triggers.active.lock().await;
    if let Some(running) = active.as_mut() {
        running.stop().await?;
    }
    *active = None;
    drop(active);
    if runtime
        .paths
        .config
        .join("native-trigger-lease.json")
        .exists()
    {
        let connection = zbus::Connection::session()
            .await
            .map_err(|e| e.to_string())?;
        let proxy = kde::accelerator(&connection).await?;
        kde::recover(&proxy, &runtime.paths.config).await?;
    }
    Ok(())
}
async fn start(runtime: &Arc<Runtime>, trigger: &Trigger) -> Result<(), String> {
    trigger.validate()?;
    if runtime.triggers.closing.load(Ordering::Relaxed) {
        return Err("WhisperFree is closing.".into());
    }
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg("--linux-trigger-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the trigger helper: {e}"))?;
    let request = format!(
        "{}\n",
        serde_json::to_string(trigger).map_err(|e| e.to_string())?
    );
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let ready = tokio::time::timeout(Duration::from_secs(8), output.next_line()).await;
    let result = match ready {
        Ok(Ok(Some(line))) => match serde_json::from_str::<helper::Event>(&line) {
            Ok(helper::Event::Ready) => Ok(()),
            Ok(helper::Event::Error { message }) => Err(message),
            _ => Err("Invalid response from the trigger helper.".into()),
        },
        _ => Err(
            "The trigger helper did not become ready. Check your desktop shortcut service.".into(),
        ),
    };
    if let Err(error) = result {
        drop(child.stdin.take());
        // EOF asks the helper to restore its changes, including after a partial setup failure.
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
        }
        return Err(error);
    }
    let state = Arc::downgrade(runtime);
    let stopping = Arc::new(AtomicBool::new(false));
    let stopped = stopping.clone();
    let events = tauri::async_runtime::spawn(async move {
        let mut held = false;
        let mut error = None;
        while let Ok(Some(line)) = output.next_line().await {
            let Some(runtime) = state.upgrade() else {
                break;
            };
            match serde_json::from_str::<helper::Event>(&line) {
                Ok(helper::Event::Pressed) if !held => {
                    let enabled = {
                        let s = runtime.state.lock().unwrap();
                        !s.updates.installing()
                            && s.status != "transcribing"
                            && !s.recording_shortcut
                    };
                    if enabled {
                        held = true;
                        let _ = runtime.commands.send(WorkerCommand::ShortcutPressed);
                    }
                }
                Ok(helper::Event::Released) if held => {
                    held = false;
                    let _ = runtime.commands.send(WorkerCommand::ShortcutReleased);
                }
                Ok(helper::Event::Error { message }) => {
                    error = Some(message);
                    break;
                }
                _ => {}
            }
        }
        if let Some(runtime) = state.upgrade() {
            if held {
                let _ = runtime.commands.send(WorkerCommand::ShortcutReleased);
            }
            if !stopped.load(Ordering::Relaxed) {
                runtime.update(|s| {
                    s.shortcut = None;
                    s.message = error.unwrap_or_else(|| {
                        "The trigger helper stopped. Set the trigger again to reconnect.".into()
                    });
                });
            }
        }
    });
    *runtime.triggers.active.lock().await = Some(Running {
        child,
        events,
        stopping,
    });
    runtime.update(|s| {
        s.shortcut = Some(trigger.label());
        s.message = "Trigger enabled. It will reconnect when WhisperFree starts.".into();
    });
    Ok(())
}
fn editable(runtime: &Runtime) -> Result<(), String> {
    let state = runtime.state.lock().unwrap();
    if matches!(state.status.as_str(), "recording" | "transcribing") || state.updates.installing() {
        return Err("Finish dictation and updates before changing the trigger.".into());
    }
    Ok(())
}
pub async fn initialize(runtime: Arc<Runtime>) {
    let (keyboard, mouse, middle) = kde::capabilities().await;
    runtime.update(|s| {
        s.native_shortcuts = keyboard;
        s.native_mouse = mouse;
        s.native_middle_mouse = middle;
    });
    let _operation = runtime.triggers.operation.lock().await;
    if keyboard {
        if let Err(error) = stop_active(&runtime).await {
            runtime.update(|s| s.message = error);
            return;
        }
    }
    let saved = runtime
        .state
        .lock()
        .unwrap()
        .preferences
        .native_trigger
        .clone();
    if let Some(trigger) = saved {
        if !keyboard {
            runtime.update(|s| s.message = "Your saved trigger needs KDE Plasma 6. Use the desktop shortcut dialog on this desktop.".into());
            return;
        }
        if let Err(error) = start(&runtime, &trigger).await {
            runtime.update(|s| s.message = error);
        }
    }
}
pub fn install_capture(runtime: Arc<Runtime>) -> Result<(), String> {
    capture::install(runtime)
}

pub async fn begin_capture(runtime: Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.triggers.operation.lock().await;
    editable(&runtime)?;
    if !runtime.state.lock().unwrap().native_shortcuts {
        return Err("Direct trigger capture is unavailable on this desktop.".into());
    }
    stop_active(&runtime).await?;
    // Keep a portal binding alive so Escape does not discard it.
    runtime.triggers.capture.lock().unwrap().begin();
    runtime.update(|s| {
        s.recording_shortcut = true;
        if s.preferences.native_trigger.is_some() {
            s.shortcut = None;
        }
        s.message = "Press and release a key or mouse button. Escape cancels.".into();
    });
    Ok(())
}
async fn finish_capture(runtime: Arc<Runtime>, trigger: Option<Trigger>) -> Result<(), String> {
    let _operation = runtime.triggers.operation.lock().await;
    let previous = runtime
        .state
        .lock()
        .unwrap()
        .preferences
        .native_trigger
        .clone();
    let wanted = trigger.as_ref().or(previous.as_ref());
    let result = if let Some(trigger) = wanted {
        start(&runtime, trigger).await
    } else {
        Ok(())
    };
    if let Err(error) = result {
        if trigger.is_some() {
            if let Some(previous) = &previous {
                let _ = start(&runtime, previous).await;
            }
        }
        runtime.update(|s| {
            s.recording_shortcut = false;
            s.message = error.clone();
        });
        return Err(error);
    }
    if let Some(trigger) = trigger {
        crate::integration::disable_shortcut(&runtime).await;
        runtime.update(|s| s.shortcut = Some(trigger.label()));
        let saved = {
            let mut state = runtime.state.lock().unwrap();
            let mut prefs = state.preferences.clone();
            if trigger.modifier_only() {
                prefs.hold_to_record = false;
            }
            prefs.native_trigger = Some(trigger);
            let saved = runtime.paths.save(&prefs);
            if saved.is_ok() {
                state.preferences = prefs;
            }
            saved
        };
        if let Err(error) = saved {
            stop_active(&runtime).await?;
            if let Some(previous) = previous {
                let _ = start(&runtime, &previous).await;
            }
            runtime.update(|s| {
                s.recording_shortcut = false;
                s.message = error.clone();
            });
            return Err(error);
        }
    }
    runtime.update(|s| {
        s.recording_shortcut = false;
        s.message = if s.preferences.native_trigger.is_some() {
            "Trigger enabled. It will reconnect when WhisperFree starts.".into()
        } else {
            "Ready to dictate".into()
        };
    });
    Ok(())
}
#[tauri::command]
pub async fn cancel_shortcut(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    if runtime.triggers.capture.lock().unwrap().cancel() {
        finish_capture(runtime.inner().clone(), None).await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn clear_shortcut(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    let _operation = runtime.triggers.operation.lock().await;
    editable(&runtime)?;
    runtime.triggers.capture.lock().unwrap().cancel();
    crate::integration::disable_shortcut(&runtime).await;
    stop_active(&runtime).await?;
    let mut state = runtime.state.lock().unwrap();
    let mut prefs = state.preferences.clone();
    prefs.native_trigger = None;
    runtime.paths.save(&prefs)?;
    state.preferences = prefs;
    drop(state);
    runtime.update(|s| {
        s.recording_shortcut = false;
        s.shortcut = None;
        s.message = "Trigger removed. The original desktop bindings are restored.".into();
    });
    Ok(())
}
#[tauri::command]
pub async fn desktop_shortcut(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    clear_shortcut(runtime.clone()).await?;
    crate::integration::enable_shortcut(runtime.inner().clone()).await
}
pub async fn shutdown(runtime: &Runtime) {
    runtime.triggers.closing.store(true, Ordering::Relaxed);
    let _operation = runtime.triggers.operation.lock().await;
    if let Err(error) = stop_active(runtime).await {
        eprintln!("Trigger cleanup: {error}");
    }
}
