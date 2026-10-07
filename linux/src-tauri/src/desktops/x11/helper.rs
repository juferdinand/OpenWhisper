use super::{connection::Connection, Trigger};
use serde::{Deserialize, Serialize};
use std::io::Write;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use x11_dl::xlib;

#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Probe { display: String },
    Bind { display: String, trigger: Trigger },
    Paste { display: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Ready {
        trigger: Option<Trigger>,
        paste: bool,
    },
    Pressed,
    Released,
    Complete,
    Error {
        message: String,
    },
}

fn emit(event: Event) -> Result<(), String> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &event).map_err(|_| "Trigger communication failed")?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| "Trigger communication failed".into())
}

async fn perform(request: Request) -> Result<(), String> {
    let (name, trigger, paste) = match request {
        Request::Probe { display } => (display, None, false),
        Request::Bind { display, trigger } => (display, Some(trigger), false),
        Request::Paste { display } => (display, None, true),
    };
    let connection = Connection::open(&name)?;
    if paste {
        connection.paste()?;
        return emit(Event::Complete);
    }
    let selected = trigger
        .as_ref()
        .map(|trigger| connection.bind(trigger))
        .transpose()?;
    emit(Event::Ready {
        trigger: selected.clone(),
        paste: connection.paste_supported(),
    })?;
    let Some(trigger) = selected else {
        return Ok(());
    };
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(15));
    let mut termination = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| "Trigger shutdown monitoring failed")?;
    let mut input = tokio::io::stdin();
    let mut byte = [0];
    let mut held = false;
    let result = loop {
        tokio::select! {
            _ = termination.recv() => break Ok(()),
            // EOF on the retained parent pipe releases every passive grab.
            _ = input.read(&mut byte) => break Ok(()),
            _ = interval.tick() => {
                while let Some(event) = connection.next_event() {
                    let kind = event.get_type();
                    if kind == xlib::MappingNotify {
                        if held { emit(Event::Released)?; }
                        return Err("The keyboard layout changed. Set the X11 trigger again.".into());
                    }
                    if kind == connection.xkb_event {
                        // Xkb events share the XEvent ABI; inspect only announced event types.
                        let any = unsafe { &*((&event as *const xlib::XEvent).cast::<xlib::XkbAnyEvent>()) };
                        let invalidated = match any.xkb_type {
                            xlib::XkbMapNotify | xlib::XkbNewKeyboardNotify => true,
                            xlib::XkbStateNotify => {
                                let state = unsafe { &*((&event as *const xlib::XEvent).cast::<xlib::XkbStateNotifyEvent>()) };
                                state.group as u32 != trigger.group
                            },
                            _ => false,
                        };
                        if invalidated {
                            if held { emit(Event::Released)?; }
                            return Err("The keyboard layout changed. Set the X11 trigger again.".into());
                        }
                    }
                    if kind == xlib::KeyPress || kind == xlib::KeyRelease {
                        let key = unsafe { event.key };
                        if key.keycode != trigger.keycode { continue; }
                        if (key.state >> 13) & 3 != trigger.group {
                            if held { emit(Event::Released)?; }
                            return Err("The keyboard layout changed. Set the X11 trigger again.".into());
                        }
                        if kind == xlib::KeyPress && !held { held = true; emit(Event::Pressed)?; }
                        if kind == xlib::KeyRelease && held { held = false; emit(Event::Released)?; }
                    }
                }
            }
        }
    };
    if held {
        emit(Event::Released)?;
    }
    result
}

/// Entry point before GTK/audio initialization. Only this child owns its Xlib handler.
pub fn run() -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return 1,
    };
    let result = runtime.block_on(async {
        let mut input = BufReader::new(tokio::io::stdin().take(2049));
        let mut line = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            input.read_until(b'\n', &mut line),
        )
        .await
        .map_err(|_| "Trigger setup timed out")?
        .map_err(|_| "Trigger communication failed")?;
        if line.len() > 2048 || line.last() != Some(&b'\n') {
            return Err("Invalid trigger request".into());
        }
        let request =
            serde_json::from_slice::<Request>(&line).map_err(|_| "Invalid trigger request")?;
        perform(request).await
    });
    // Tokio stdin uses a blocking read. SIGTERM must not wait for the parent to
    // close its pipe after the connection has already released every grab.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    match result {
        Ok(()) => 0,
        Err(message) => {
            let _ = emit(Event::Error { message });
            1
        }
    }
}
