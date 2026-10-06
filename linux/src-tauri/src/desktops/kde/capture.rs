use super::{finish_capture, trigger, Trigger};
use crate::Runtime;
use gtk::{gdk, glib::Propagation, prelude::*};
use std::sync::Arc;
use tauri::Manager;

#[derive(Default)]
pub struct Capture {
    active: bool,
    candidate: Option<(Input, Trigger)>,
}
#[derive(Clone, Copy, PartialEq)]
enum Input {
    Key(u16),
    Mouse(u32),
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
    fn press(&mut self, input: Input, trigger: Trigger) {
        self.candidate = Some((input, trigger));
    }
    fn release(&mut self, input: Input) -> Option<Trigger> {
        if self
            .candidate
            .as_ref()
            .is_some_and(|(pressed, _)| *pressed == input)
        {
            self.active = false;
            self.candidate.take().map(|(_, trigger)| trigger)
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
    let mut capture = runtime.triggers.capture.lock().unwrap();
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
        if let Some(trigger) = trigger::from_gdk(event.keyval(), event.state()) {
            capture.press(Input::Key(event.hardware_keycode()), trigger);
        }
    } else if let Some(trigger) = capture.release(Input::Key(event.hardware_keycode())) {
        drop(capture);
        finish(runtime.clone(), Some(trigger));
    }
    Propagation::Stop
}
fn mouse(runtime: &Arc<Runtime>, event: &gdk::EventButton, down: bool) -> Propagation {
    let mut capture = runtime.triggers.capture.lock().unwrap();
    if !capture.active || matches!(event.button(), 1 | 3) {
        return Propagation::Proceed;
    }
    if down {
        let trigger = Trigger::Mouse {
            button: event.button(),
        };
        if trigger.validate().is_ok() {
            capture.press(Input::Mouse(event.button()), trigger);
        }
    } else if let Some(trigger) = capture.release(Input::Mouse(event.button())) {
        drop(capture);
        finish(runtime.clone(), Some(trigger));
    }
    Propagation::Stop
}
pub fn install(runtime: Arc<Runtime>) -> Result<(), String> {
    let window = runtime
        .app
        .get_webview_window("main")
        .ok_or("Settings window unavailable")?;
    let state = runtime.clone();
    window
        .gtk_window()
        .map_err(|e| e.to_string())?
        .connect_focus_out_event(move |_, _| {
            if state.triggers.capture.lock().unwrap().cancel() {
                finish(state.clone(), None);
            }
            Propagation::Proceed
        });
    window
        .with_webview(move |webview| {
            let view = webview.inner();
            let state = runtime.clone();
            view.connect_key_press_event(move |_, event| key(&state, event, true));
            let state = runtime.clone();
            view.connect_key_release_event(move |_, event| key(&state, event, false));
            // WebKit handles auxiliary buttons before the specific GTK button signals.
            // Intercept the generic event first, and only during explicit trigger capture.
            view.connect_event(move |_, event| {
                if let Some(button) = event.downcast_ref::<gdk::EventButton>() {
                    match event.event_type() {
                        gdk::EventType::ButtonPress => return mouse(&runtime, button, true),
                        gdk::EventType::ButtonRelease => return mouse(&runtime, button, false),
                        _ => {}
                    }
                }
                Propagation::Proceed
            });
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_commits_on_release_and_discards_an_incomplete_chord() {
        let mut capture = Capture::default();
        capture.begin();
        capture.press(Input::Key(37), Trigger::Key { key: 0x01000021 });
        let chord = Trigger::Key { key: 0x04000056 };
        capture.press(Input::Key(55), chord.clone());
        assert_eq!(capture.release(Input::Key(37)), None);
        assert_eq!(capture.release(Input::Key(55)), Some(chord));
        assert!(!capture.active);
        capture.begin();
        capture.press(Input::Mouse(8), Trigger::Mouse { button: 8 });
        assert!(capture.cancel());
        assert_eq!(capture.release(Input::Mouse(8)), None);
    }
}
