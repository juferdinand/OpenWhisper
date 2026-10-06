use super::{bindings as kde, Trigger};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Ready,
    Pressed,
    Released,
    Error { message: String },
}
fn send(event: Event) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    writeln!(
        stdout,
        "{}",
        serde_json::to_string(&event).map_err(|e| e.to_string())?
    )
    .and_then(|_| stdout.flush())
    .map_err(|e| e.to_string())
}

pub fn run() -> i32 {
    let runtime = tokio::runtime::Runtime::new().expect("Could not start trigger helper");
    let result = match runtime.block_on(session()) {
        Ok(()) => 0,
        Err(message) => {
            let _ = send(Event::Error { message });
            1
        }
    };
    runtime.shutdown_background();
    result
}
async fn session() -> Result<(), String> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|e| e.to_string())?;
    let mut input = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    (&mut input)
        .take(2048)
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    if !line.ends_with('\n') {
        return Err("Invalid trigger request.".into());
    }
    let trigger: Trigger = serde_json::from_str(&line).map_err(|_| "Invalid trigger request.")?;
    trigger.validate()?;
    let (keyboard, mouse, middle) = kde::capabilities().await;
    if !keyboard {
        return Err("Direct triggers require KDE Plasma 6. Use the desktop shortcut dialog on this desktop.".into());
    }
    if matches!(trigger, Trigger::Mouse { .. }) && !mouse {
        return Err("Direct mouse triggers require KDE Plasma 6 on Wayland and KDE's configuration utilities.".into());
    }
    if matches!(trigger, Trigger::Mouse { button: 2 }) && !middle {
        return Err("The middle mouse button requires KDE Plasma 6.3 or later. Use an extra mouse button instead.".into());
    }
    let connection = zbus::Connection::session()
        .await
        .map_err(|e| e.to_string())?;
    let proxy = kde::accelerator(&connection).await?;
    let paths = crate::settings::Paths::new()?;
    kde::recover(&proxy, &paths.config).await?;
    let candidates = match trigger {
        Trigger::Key { key } => vec![(key, None)],
        Trigger::Mouse { .. } => kde::mouse_keys()
            .into_iter()
            .map(|(key, name)| (key, Some(format!("Key,{name}"))))
            .collect(),
    };
    let mut selected = None;
    for (key, mapping) in candidates {
        let free: bool = proxy
            .call("globalShortcutAvailable", &((vec![key],), ""))
            .await
            .map_err(|e| e.to_string())?;
        if free {
            selected = Some((key, mapping));
            break;
        }
    }
    let (key, mapping) = selected.ok_or(
        "This trigger conflicts with an existing desktop shortcut. Choose another trigger.",
    )?;
    let lease = kde::Lease::new(trigger, mapping, &paths.config)?;
    let result = async {
        let action = vec![lease.component.as_str(), kde::ACTION, "OpenWhisper", "Start or stop dictation"];
        let _: () = proxy.call("doRegister", &(&action,)).await.map_err(|e| e.to_string())?;
        let path: zbus::zvariant::OwnedObjectPath = proxy.call("getComponent", &(&lease.component,)).await.map_err(|e| e.to_string())?;
        let component = zbus::Proxy::new(&connection, "org.kde.kglobalaccel", path, "org.kde.kglobalaccel.Component").await.map_err(|e| e.to_string())?;
        // A single stream preserves press/release ordering, including modifier-only bursts.
        let mut events = component.receive_all_signals().await.map_err(|e| e.to_string())?;
        let bound: Vec<(Vec<i32>,)> = proxy.call("setShortcutKeys", &(&action, vec![(vec![key],)], 6u32)).await.map_err(|e| e.to_string())?;
        // Qt serializes each QKeySequence as four entries, padding unused keys with zero.
        if bound.len() != 1 || bound[0].0.first() != Some(&key) || bound[0].0.iter().skip(1).any(|k| *k != 0) { return Err("The desktop rejected this trigger because it conflicts with another shortcut.".into()); }
        lease.apply_mouse()?;
        send(Event::Ready)?;
        let mut held = false;
        let mut byte = [0];
        loop {
            let down = tokio::select! {
                _ = input.read(&mut byte) => break,
                _ = terminate.recv() => break,
                _ = interrupt.recv() => break,
                event = events.next() => match event {
                    Some(event) => {
                        let down = match event.header().member().map(|m| m.as_str()) {
                            Some("globalShortcutPressed") => true,
                            Some("globalShortcutReleased") => false,
                            _ => continue,
                        };
                        let (owner, action, _): (String, String, i64) = event.body().deserialize().map_err(|e| e.to_string())?;
                        if owner != lease.component || action != kde::ACTION { continue; }
                        down
                    },
                    None => return Err("The desktop shortcut service disconnected.".into()),
                },
            };
            // KDE has a separate repeat signal; also reject duplicate edges defensively.
            if down != held { held = down; send(if down { Event::Pressed } else { Event::Released })?; }
        }
        Ok(())
    }.await;
    let cleanup = lease.release(&proxy, &paths.config).await;
    cleanup.and(result)
}
