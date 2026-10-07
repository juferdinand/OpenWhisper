use super::{finish_capture, trigger, Trigger};
use crate::Runtime;
use gtk::{gdk, glib::Propagation, prelude::*};
use std::sync::Arc;
use tauri::Manager;

#[derive(Default)]
pub struct Capture {
    active: bool,
    candidate: Option<Trigger>,
}
impl Capture {
    pub fn begin(&mut self) {
        self.active = true;
        self.candidate = None;
    }
    pub fn cancel(&mut self) -> bool {
        let active = self.active;
        self.active = false;
        self.candidate = None;
        active
    }
    fn press(&mut self, trigger: Trigger) {
        self.candidate = Some(trigger);
    }
    fn release(&mut self, keycode: u32) -> Option<Trigger> {
        if self
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.keycode == keycode)
        {
            self.active = false;
            self.candidate.take()
        } else {
            None
        }
    }
}

fn finish(runtime: Arc<Runtime>, trigger: Option<Trigger>) {
    tauri::async_runtime::spawn(async move {
        let _ = finish_capture(runtime, trigger).await;
    });
}
fn key(runtime: &Arc<Runtime>, event: &gdk::EventKey, down: bool) -> Propagation {
    let mut capture = runtime.x11.capture.lock().unwrap();
    if !capture.active {
        return Propagation::Proceed;
    }
    if down && event.keyval() == gdk::keys::constants::Escape {
        capture.cancel();
        drop(capture);
        finish(runtime.clone(), None);
        return Propagation::Stop;
    }
    if down {
        if let Some(trigger) = trigger::from_event(event) {
            capture.press(trigger);
        }
    } else if let Some(trigger) = capture.release(event.hardware_keycode().into()) {
        drop(capture);
        finish(runtime.clone(), Some(trigger));
    }
    Propagation::Stop
}

pub fn install(runtime: Arc<Runtime>) -> Result<(), String> {
    let Some(display) = gdk::Display::default() else {
        return Ok(());
    };
    // A Wayland session's XWayland DISPLAY must never enable a global X11 fallback.
    if crate::desktops::shared::session::wayland() || display.type_().name() != "GdkX11Display" {
        return Ok(());
    }
    *runtime.x11.display.lock().unwrap() = Some(display.name().to_string());
    let window = runtime
        .app
        .get_webview_window("main")
        .ok_or("Settings window unavailable")?;
    let state = runtime.clone();
    window
        .gtk_window()
        .map_err(|e| e.to_string())?
        .connect_focus_out_event(move |_, _| {
            if state.x11.capture.lock().unwrap().cancel() {
                finish(state.clone(), None);
            }
            Propagation::Proceed
        });
    window
        .with_webview(move |webview| {
            let state = runtime.clone();
            webview
                .inner()
                .connect_key_press_event(move |_, event| key(&state, event, true));
            webview
                .inner()
                .connect_key_release_event(move |_, event| key(&runtime, event, false));
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn x11_capture_waits_for_the_selected_key_release_and_cancels_safely() {
        let mut capture = Capture::default();
        let trigger = Trigger {
            keycode: 74,
            keysym: 0xffc5,
            modifiers: 12,
            group: 0,
        };
        capture.begin();
        capture.press(trigger.clone());
        assert_eq!(capture.release(37), None);
        assert_eq!(capture.release(74), Some(trigger.clone()));
        assert!(!capture.active);
        capture.begin();
        capture.press(trigger);
        assert!(capture.cancel());
        assert_eq!(capture.release(74), None);
    }
}
