use crate::{Runtime, WorkerCommand};
use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut},
    remote_desktop::{DeviceType, KeyState, RemoteDesktop},
    Session,
};
use futures_util::StreamExt;
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

pub struct PasteSession {
    proxy: RemoteDesktop,
    session: Session<RemoteDesktop>,
}

pub struct ShortcutHandle {
    _task: tauri::async_runtime::JoinHandle<()>,
    configure: tokio::sync::mpsc::UnboundedSender<bool>,
}

fn shortcut_description(
    shortcuts: &[ashpd::desktop::global_shortcuts::Shortcut],
) -> Option<String> {
    shortcuts
        .iter()
        .find(|shortcut| shortcut.id() == "dictate")
        .map(|shortcut| shortcut.trigger_description().trim())
        .filter(|description| !description.is_empty())
        .map(str::to_owned)
}

fn update_shortcut(runtime: &Runtime, description: Option<String>) {
    runtime.update(|state| {
        state.message = if description.is_some() {
            "Global shortcut enabled. Your desktop controls its key binding."
        } else {
            "No shortcut assigned. Choose a key combination in your desktop's shortcut settings."
        }
        .into();
        state.shortcut = description;
    });
}

async fn configure_shortcut(
    proxy: &GlobalShortcuts,
    session: &Session<GlobalShortcuts>,
    runtime: &Runtime,
) {
    if let Err(error) = proxy
        .configure_shortcuts(session, None, Default::default())
        .await
    {
        runtime.update(|state| state.message = format!(
            "Open your desktop's shortcut settings to change the trigger. The portal could not open them: {error}"
        ));
    }
}

pub fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}
pub fn available(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|p| p.join(program).is_file()))
}

pub fn clipboard(text: &str, owner: &mut Option<Child>) -> Result<(), String> {
    let mut command = if wayland() {
        let mut c = Command::new("wl-copy");
        c.args(["--foreground", "--type", "text/plain;charset=utf-8"]);
        c
    } else {
        let mut c = Command::new("xclip");
        c.args(["-selection", "clipboard", "-quiet"]);
        c
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "Clipboard unavailable ({e}). Install {} or copy from the transcript.",
                if wayland() { "wl-clipboard" } else { "xclip" }
            )
        })?;
    if let Err(error) = child.stdin.take().unwrap().write_all(text.as_bytes()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    std::thread::sleep(Duration::from_millis(80));
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
        return Err(format!("Clipboard process exited: {status}"));
    }
    if let Some(mut old) = owner.replace(child) {
        let _ = old.kill();
        let _ = old.wait();
    }
    Ok(())
}

pub async fn enable_paste(runtime: &Arc<Runtime>) -> Result<(), String> {
    let mut holder = runtime.paste.lock().await;
    if holder.is_some() {
        return Ok(());
    }
    let result = async {
        let proxy = RemoteDesktop::new().await?;
        let session = proxy.create_session(Default::default()).await?;
        let options = ashpd::desktop::remote_desktop::SelectDevicesOptions::default()
            .set_devices(Some(DeviceType::Keyboard.into()));
        proxy.select_devices(&session, options).await?.response()?;
        let selected = proxy
            .start(&session, None, Default::default())
            .await?
            .response()?;
        if !selected.devices().contains(DeviceType::Keyboard) {
            let _ = session.close().await;
            return Err(ashpd::Error::NoResponse);
        }
        Ok::<_, ashpd::Error>(PasteSession { proxy, session })
    }
    .await
    .map_err(|e| format!("Keyboard permission unavailable: {e}. Clipboard output still works."))?;
    *holder = Some(result);
    runtime.update(|s| {
        s.paste_ready = true;
        s.message =
            "Automatic paste enabled for this session. No screen capture is requested.".into();
    });
    Ok(())
}

pub async fn disable_paste(runtime: &Arc<Runtime>) {
    if let Some(connection) = runtime.paste.lock().await.take() {
        let _ = connection.session.close().await;
    }
    runtime.update(|s| s.paste_ready = false);
}

pub async fn paste(runtime: &Arc<Runtime>) -> Result<(), String> {
    let mut guard = runtime.paste.lock().await;
    let connection = guard
        .as_ref()
        .ok_or("Text copied. Enable keyboard permission to paste automatically.")?;
    // Linux evdev keycodes. Always release both keys, including after an error.
    let mut error = None;
    for (key, state) in [
        (29, KeyState::Pressed),
        (47, KeyState::Pressed),
        (47, KeyState::Released),
        (29, KeyState::Released),
    ] {
        if let Err(e) = connection
            .proxy
            .notify_keyboard_keycode(&connection.session, key, state, Default::default())
            .await
        {
            error = Some(e.to_string());
        }
    }
    if let Some(error) = error {
        if let Some(connection) = guard.take() {
            let _ = connection.session.close().await;
        }
        runtime.update(|s| s.paste_ready = false);
        Err(format!("Text copied; automatic paste failed: {error}"))
    } else {
        Ok(())
    }
}

pub async fn enable_shortcut(runtime: Arc<Runtime>) -> Result<(), String> {
    let mut task = runtime.shortcut_task.lock().await;
    if let Some(handle) = task.as_ref() {
        return handle
            .configure
            .send(true)
            .map_err(|_| "Shortcut session ended. Restart the app to reconnect.".into());
    }
    let proxy = GlobalShortcuts::new()
        .await
        .map_err(|e| format!("Global shortcuts are unavailable: {e}. Use the Record button."))?;
    let session = proxy
        .create_session(Default::default())
        .await
        .map_err(|e| e.to_string())?;
    let mut activated = proxy.receive_activated().await.map_err(|e| e.to_string())?;
    let mut deactivated = proxy
        .receive_deactivated()
        .await
        .map_err(|e| e.to_string())?;
    let mut changed = proxy
        .receive_shortcuts_changed()
        .await
        .map_err(|e| e.to_string())?;
    let response = proxy
        .bind_shortcuts(
            &session,
            &[NewShortcut::new("dictate", "Start or stop dictation")
                .preferred_trigger("CTRL+ALT+space")],
            None,
            Default::default(),
        )
        .await
        .map_err(|e| e.to_string())?
        .response()
        .map_err(|e| format!("Shortcut setup cancelled or denied: {e}"))?;
    let description = shortcut_description(response.shortcuts());
    let unassigned = description.is_none();
    let session_path = serde_json::to_value(&session)
        .map_err(|e| e.to_string())?
        .as_str()
        .unwrap_or("")
        .to_string();
    update_shortcut(&runtime, description);
    if unassigned {
        configure_shortcut(&proxy, &session, &runtime).await;
    }
    let state = runtime.clone();
    let (configure, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let handle = tauri::async_runtime::spawn(async move {
        // Retain the session and proxy for the lifetime of the signal subscriptions.
        let mut closed = match session.receive_closed().await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = session.close().await;
                state.update(|s| {
                    s.shortcut = None;
                    s.message = format!("Could not monitor the shortcut session: {error}. Enable it again in Settings.");
                });
                state.shortcut_task.lock().await.take();
                return;
            }
        };
        loop {
            tokio::select! {
                request = requests.recv() => match request {
                    Some(true) => configure_shortcut(&proxy, &session, &state).await,
                    Some(false) | None => break,
                },
                signal = changed.next() => match signal {
                    Some(s) if s.session_handle().as_str() == session_path => update_shortcut(&state, shortcut_description(s.shortcuts())),
                    None => break,
                    _ => {},
                },
                signal = activated.next() => match signal {
                    Some(s) if s.shortcut_id() == "dictate" && s.session_handle().as_str() == session_path => { let _ = state.commands.send(WorkerCommand::ShortcutPressed); },
                    None => break,
                    _ => {},
                },
                signal = deactivated.next() => match signal {
                    Some(s) if s.shortcut_id() == "dictate" && s.session_handle().as_str() == session_path => { let _ = state.commands.send(WorkerCommand::ShortcutReleased); },
                    None => break,
                    _ => {},
                },
                _ = closed.next() => break,
            }
        }
        let _ = session.close().await;
        drop(proxy);
        state.update(|s| {
            s.shortcut = None;
            s.message = "Shortcut session ended. Enable it again in Settings.".into();
        });
        state.shortcut_task.lock().await.take();
    });
    *task = Some(ShortcutHandle {
        _task: handle,
        configure,
    });
    Ok(())
}

pub async fn disable_shortcut(runtime: &Runtime) {
    let task = runtime.shortcut_task.lock().await.take();
    if let Some(task) = task {
        let _ = task.configure.send(false);
        let _ = task._task.await;
    }
}
