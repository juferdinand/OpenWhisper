mod capture;
mod connection;
pub mod helper;
mod trigger;
pub use trigger::Trigger;

use crate::{Runtime, WorkerCommand};
use helper::{Event, Request};
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
    process::{Child, ChildStdout, Command},
};

#[derive(Default)]
pub struct Service {
    pub(crate) permission_operation: tokio::sync::Mutex<()>,
    operation: tokio::sync::Mutex<()>,
    active: tokio::sync::Mutex<Option<Running>>,
    capture: Mutex<capture::Capture>,
    display: Mutex<Option<String>>,
    paste_enabled: AtomicBool,
    closing: AtomicBool,
}
struct Running {
    child: Child,
    events: tauri::async_runtime::JoinHandle<()>,
    stopping: Arc<AtomicBool>,
}
impl Running {
    async fn stop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        drop(self.child.stdin.take());
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await;
        }
        self.events.abort();
    }
}

fn display(runtime: &Runtime) -> Result<String, String> {
    if runtime.x11.closing.load(Ordering::Acquire) {
        return Err("OpenWhisper is closing.".into());
    }
    runtime.x11.display.lock().unwrap().clone().ok_or_else(|| "Native X11 keyboard support is unavailable. Use the Record button and clipboard output.".into())
}

async fn call_helper(
    request: Request,
) -> Result<(Child, tokio::io::Lines<BufReader<ChildStdout>>, Event), String> {
    let mut child = Command::new(
        std::env::current_exe().map_err(|_| "Could not start the X11 keyboard helper")?,
    )
    .arg("--linux-x11-helper")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .map_err(|_| "Could not start the X11 keyboard helper")?;
    let line = format!(
        "{}\n",
        serde_json::to_string(&request).map_err(|_| "Invalid trigger request")?
    );
    let setup = async {
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(line.as_bytes())
            .await
            .map_err(|_| "Trigger communication failed")?;
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let response = lines
            .next_line()
            .await
            .map_err(|_| "Trigger communication failed")?
            .ok_or("The X11 keyboard helper stopped")?;
        if response.len() > 2048 {
            return Err("Invalid trigger response".into());
        }
        let event =
            serde_json::from_str::<Event>(&response).map_err(|_| "Invalid trigger response")?;
        if let Event::Error { message } = event {
            return Err(message);
        }
        Ok::<_, String>((lines, event))
    };
    match tokio::time::timeout(Duration::from_secs(4), setup).await {
        Ok(Ok((lines, event))) => Ok((child, lines, event)),
        result => {
            drop(child.stdin.take());
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
            Err(match result { Ok(Err(error)) => error, _ => "The X11 keyboard helper did not become ready. Use the Record button and clipboard output.".into() })
        }
    }
}
async fn one_shot(request: Request) -> Result<Event, String> {
    let (mut child, _, event) = call_helper(request).await?;
    drop(child.stdin.take());
    let status = tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .map_err(|_| "The X11 keyboard helper did not finish")?
        .map_err(|_| "The X11 keyboard helper stopped")?;
    if !status.success() {
        return Err("The X11 keyboard helper stopped".into());
    }
    Ok(event)
}
async fn stop_active(runtime: &Runtime) {
    if let Some(mut running) = runtime.x11.active.lock().await.take() {
        running.stop().await;
    }
}
fn editable(runtime: &Runtime) -> Result<(), String> {
    let state = runtime.state.lock().unwrap();
    if matches!(state.status.as_str(), "recording" | "transcribing") || state.updates.installing() {
        return Err("Finish dictation and updates before changing the trigger.".into());
    }
    Ok(())
}
async fn start(runtime: &Arc<Runtime>, trigger: &Trigger) -> Result<Trigger, String> {
    trigger.validate()?;
    let (child, mut lines, ready) = call_helper(Request::Bind {
        display: display(runtime)?,
        trigger: trigger.clone(),
    })
    .await?;
    let Event::Ready {
        trigger: Some(selected),
        ..
    } = ready
    else {
        return Err("Invalid trigger response".into());
    };
    let selected_label = selected.label();
    let state = Arc::downgrade(runtime);
    let stopping = Arc::new(AtomicBool::new(false));
    let stopped = stopping.clone();
    let events = tauri::async_runtime::spawn(async move {
        let mut held = false;
        let mut error = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(runtime) = state.upgrade() else {
                break;
            };
            if line.len() > 2048 {
                break;
            }
            match serde_json::from_str::<Event>(&line) {
                Ok(Event::Pressed) if !held => {
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
                Ok(Event::Released) if held => {
                    held = false;
                    let _ = runtime.commands.send(WorkerCommand::ShortcutReleased);
                }
                Ok(Event::Error { message }) => {
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
            if !stopped.load(Ordering::Acquire) {
                runtime.update(|s| {
                    s.shortcut = None;
                    s.message = error.unwrap_or_else(|| {
                        "The X11 keyboard helper stopped. Set the trigger again to reconnect."
                            .into()
                    });
                });
            }
        }
    });
    *runtime.x11.active.lock().await = Some(Running {
        child,
        events,
        stopping,
    });
    runtime.update(|s| {
        s.shortcut = Some(selected_label);
        s.message = "X11 trigger enabled. It will reconnect when OpenWhisper starts.".into();
    });
    Ok(selected)
}

pub fn install_capture(runtime: Arc<Runtime>) -> Result<(), String> {
    capture::install(runtime)
}
pub async fn initialize(runtime: Arc<Runtime>) {
    let Ok(name) = display(&runtime) else {
        return;
    };
    let Ok(Event::Ready { paste, .. }) = one_shot(Request::Probe { display: name }).await else {
        return;
    };
    let native = !runtime.state.lock().unwrap().native_shortcuts;
    runtime.update(|s| {
        s.native_paste = paste;
        if native {
            s.native_x11 = true;
            s.native_shortcuts = true;
        }
    });
    if !native {
        return;
    }
    let _operation = runtime.x11.operation.lock().await;
    let saved = runtime
        .state
        .lock()
        .unwrap()
        .preferences
        .x11_trigger
        .clone();
    if let Some(trigger) = saved {
        if let Err(error) = start(&runtime, &trigger).await {
            runtime.update(|s| s.message = error);
        }
    }
}
pub async fn begin_capture(runtime: Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.x11.operation.lock().await;
    editable(&runtime)?;
    if !runtime.state.lock().unwrap().native_x11 {
        return Err("Direct trigger capture is unavailable on this desktop.".into());
    }
    stop_active(&runtime).await;
    runtime.x11.capture.lock().unwrap().begin();
    runtime.update(|s| {
        s.recording_shortcut = true;
        s.shortcut = None;
        s.message = "Press and release a keyboard key. Escape cancels.".into();
    });
    Ok(())
}
async fn finish_capture(runtime: Arc<Runtime>, trigger: Option<Trigger>) -> Result<(), String> {
    let _operation = runtime.x11.operation.lock().await;
    let previous = runtime
        .state
        .lock()
        .unwrap()
        .preferences
        .x11_trigger
        .clone();
    let wanted = trigger.as_ref().or(previous.as_ref());
    let result = match wanted {
        Some(trigger) => start(&runtime, trigger).await.map(Some),
        None => Ok(None),
    };
    let selected = match result {
        Ok(selected) => selected,
        Err(error) => {
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
    };
    if trigger.is_some() {
        crate::desktops::shared::portals::disable_shortcut(&runtime).await;
        let saved = {
            let mut state = runtime.state.lock().unwrap();
            let mut prefs = state.preferences.clone();
            prefs.x11_trigger = selected;
            let saved = runtime.paths.save(&prefs);
            if saved.is_ok() {
                state.preferences = prefs;
            }
            saved
        };
        if let Err(error) = saved {
            stop_active(&runtime).await;
            if let Some(previous) = &previous {
                let _ = start(&runtime, previous).await;
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
        s.message = if s.preferences.x11_trigger.is_some() {
            "X11 trigger enabled. It will reconnect when OpenWhisper starts."
        } else {
            "Ready to dictate"
        }
        .into();
    });
    Ok(())
}
pub async fn cancel_capture(runtime: Arc<Runtime>) -> Result<(), String> {
    if runtime.x11.capture.lock().unwrap().cancel() {
        finish_capture(runtime, None).await?;
    }
    Ok(())
}
pub async fn clear_trigger(runtime: Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.x11.operation.lock().await;
    editable(&runtime)?;
    {
        let mut state = runtime.state.lock().unwrap();
        let mut prefs = state.preferences.clone();
        prefs.x11_trigger = None;
        runtime.paths.save(&prefs)?;
        state.preferences = prefs;
    }
    runtime.x11.capture.lock().unwrap().cancel();
    crate::desktops::shared::portals::disable_shortcut(&runtime).await;
    stop_active(&runtime).await;
    runtime.update(|s| {
        s.recording_shortcut = false;
        s.shortcut = None;
        s.message = "X11 trigger removed. The key is available to other applications.".into();
    });
    Ok(())
}
pub async fn enable_paste(runtime: &Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.x11.operation.lock().await;
    let Event::Ready { paste: true, .. } = one_shot(Request::Probe {
        display: display(runtime)?,
    })
    .await?
    else {
        return Err(
            "Automatic X11 paste is unavailable. Clipboard output remains available.".into(),
        );
    };
    crate::desktops::shared::portals::disable_paste(runtime).await;
    if runtime.x11.closing.load(Ordering::Acquire) {
        return Err("OpenWhisper is closing.".into());
    }
    runtime.x11.paste_enabled.store(true, Ordering::Release);
    runtime.update(|s| {
        s.paste_ready = true;
        s.message =
            "Automatic paste enabled for this X11 session. No screen capture is requested.".into();
    });
    Ok(())
}
pub fn disable_paste(runtime: &Runtime) {
    runtime.x11.paste_enabled.store(false, Ordering::Release);
    runtime.update(|s| s.paste_ready = false);
}
pub fn paste_enabled(runtime: &Runtime) -> bool {
    runtime.x11.paste_enabled.load(Ordering::Acquire)
}
pub async fn paste(runtime: &Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.x11.operation.lock().await;
    if !paste_enabled(runtime) {
        return Err(
            "Text copied. Allow automatic X11 paste for this session or paste manually.".into(),
        );
    }
    let paste_is_trigger = {
        let state = runtime.state.lock().unwrap();
        if state.native_x11 {
            state
                .preferences
                .x11_trigger
                .as_ref()
                .is_some_and(|trigger| trigger.keysym == b'v' as u32 && trigger.modifiers == 4)
        } else {
            matches!(
                state.preferences.native_trigger,
                Some(crate::desktops::kde::Trigger::Key { key: 0x0400_0056 })
            )
        }
    };
    if paste_is_trigger {
        return Err(
            "Text copied. Ctrl+V is your trigger; use another trigger for automatic paste.".into(),
        );
    }
    let Event::Complete = one_shot(Request::Paste {
        display: display(runtime)?,
    })
    .await?
    else {
        return Err("Text copied; automatic X11 paste failed. Paste manually.".into());
    };
    Ok(())
}
pub async fn shutdown(runtime: &Runtime) {
    runtime.x11.closing.store(true, Ordering::Release);
    let _operation = runtime.x11.operation.lock().await;
    runtime.x11.paste_enabled.store(false, Ordering::Release);
    runtime.x11.capture.lock().unwrap().cancel();
    stop_active(runtime).await;
}
