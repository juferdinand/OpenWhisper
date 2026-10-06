use crate::{audio, integration, Runtime, WorkerCommand};
use std::{
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use whisperfree_core::catalog;

pub fn run(runtime: Arc<Runtime>, commands: mpsc::Receiver<WorkerCommand>) {
    let mut engine = match whisperfree_speech::SpeechEngine::new() {
        Ok(e) => e,
        Err(e) => {
            runtime.error(e);
            return;
        }
    };
    let mut recording: Option<(audio::Capture, Instant, crate::Preferences)> = None;
    loop {
        let command = match commands.recv_timeout(Duration::from_millis(200)) {
            Ok(c) => Some(c),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(_) => break,
        };
        if matches!(command, Some(WorkerCommand::Cancel)) {
            recording.take();
            runtime.update(|s| {
                s.status = "idle".into();
                s.message = "Recording cancelled. Audio discarded.".into();
                s.elapsed = 0;
            });
            continue;
        }
        let prefs = runtime.state.lock().unwrap().preferences.clone();
        let should_toggle = matches!(command, Some(WorkerCommand::Toggle))
            || matches!(command, Some(WorkerCommand::ShortcutPressed))
                && (!prefs.hold_to_record || recording.is_none());
        let should_stop =
            matches!(command, Some(WorkerCommand::ShortcutReleased)) && prefs.hold_to_record;
        if recording.is_none() && should_toggle {
            let model = catalog().into_iter().find(|m| m.id == prefs.model).unwrap();
            if !runtime.paths.models.join(model.file).is_file() {
                runtime.error("Download the selected model in Models before recording.".into());
                continue;
            }
            match audio::Capture::start(&prefs.microphone) {
                Ok(capture) => {
                    recording = Some((capture, Instant::now(), prefs));
                    runtime.update(|s| {
                        s.status = "recording".into();
                        s.message = "Listening. Speak naturally, then stop to transcribe.".into();
                        s.elapsed = 0;
                    });
                }
                Err(error) => runtime.error(error),
            }
        } else if recording.is_some() && (should_toggle || should_stop) {
            let (capture, _, prefs) = recording.take().unwrap();
            runtime.update(|s| {
                s.status = "transcribing".into();
                s.message = "Transcribing locally… The first run also loads the model.".into();
            });
            let result = (|| {
                let samples = capture.finish()?;
                if samples.len() < 3200
                    || samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>()
                        / (samples.len().max(1) as f64)
                        < 0.00000025
                {
                    return Ok(String::new());
                }
                let model = catalog().into_iter().find(|m| m.id == prefs.model).unwrap();
                engine.load(
                    &runtime.paths.models.join(model.file),
                    model.family == "parakeet",
                    prefs.gpu,
                )?;
                let raw = engine.transcribe(&samples, &prefs.language, &prefs.vocabulary)?;
                Ok::<_, String>(whisperfree_core::process(
                    &raw,
                    &prefs.vocabulary,
                    &prefs.snippets,
                ))
            })();
            match result {
                Ok(text) if text.is_empty() => runtime.update(|s| {
                    s.status = "idle".into();
                    s.message = "No speech detected. Check your microphone and try again.".into();
                }),
                Ok(text) => {
                    let copied =
                        integration::clipboard(&text, &mut runtime.clipboard.lock().unwrap());
                    let message = match copied {
                        Ok(_) => "Copied. Paste your text with Ctrl+V.".into(),
                        Err(ref e) => e.clone(),
                    };
                    runtime.update(|s| {
                        s.status = "done".into();
                        s.transcript = text.clone();
                        if s.preferences.keep_history {
                            s.history.insert(0, text);
                            s.history.truncate(20);
                        }
                        s.message = message;
                    });
                    {
                        let state = runtime.state.lock().unwrap();
                        if state.preferences.keep_history {
                            if let Err(error) = runtime.paths.save_history(&state.history) {
                                drop(state);
                                runtime.update(|s| {
                                    s.message = format!(
                                        "Transcript ready; history could not be saved: {error}"
                                    )
                                });
                            }
                        }
                    }
                    if prefs.output == "paste" && copied.is_ok() {
                        let state = runtime.clone();
                        tauri::async_runtime::block_on(async move {
                            let message = match integration::paste(&state).await {
                                Ok(_) => "Text pasted into the focused app.".into(),
                                Err(e) => e,
                            };
                            state.update(|s| s.message = message);
                        });
                    }
                }
                Err(error) => runtime.error(error),
            }
            // Ignore shortcut repeats queued during inference.
            while commands.try_recv().is_ok() {}
        } else if let Some((capture, start, _)) = &recording {
            runtime.update(|s| {
                s.elapsed = start.elapsed().as_secs();
                s.level = capture.level();
            });
        }
    }
}
