use crate::{
    audio, integration,
    transcription::{SavedRecording, Service},
    Runtime, WorkerCommand,
};
use openwhisper_core::catalog;
use std::{
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

pub fn run(runtime: Arc<Runtime>, commands: mpsc::Receiver<WorkerCommand>) {
    let mut engine = match Service::new() {
        Ok(e) => e,
        Err(e) => {
            runtime.error(e);
            return;
        }
    };
    let recovery_directory = runtime.paths.config.join("recovery");
    let mut pending: Option<(Vec<f32>, Option<SavedRecording>)> = None;
    if SavedRecording::latest(&recovery_directory).is_some() {
        runtime.update(|s| {
            s.recovery_available = true;
            s.message =
                "An unfinished recording is saved. Retry transcription or discard it.".into();
        });
    }
    let gpu = engine.gpu_name();
    runtime.update(|s| {
        s.gpu_available = gpu.is_some();
        s.gpu_device = gpu;
    });
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
        if recording.is_none() && matches!(command, Some(WorkerCommand::DiscardRecovery)) {
            let saved = pending
                .as_ref()
                .and_then(|(_, saved)| saved.clone())
                .or_else(|| SavedRecording::latest(&recovery_directory));
            if let Some(saved) = saved {
                if let Err(error) = saved.remove() {
                    runtime.error(error);
                    continue;
                }
            }
            pending.take();
            runtime.update(|s| {
                s.recovery_available = SavedRecording::latest(&recovery_directory).is_some();
                s.status = "idle".into();
                s.message = "Recording cancelled. Audio discarded.".into();
            });
            continue;
        }
        let retry = recording.is_none() && matches!(command, Some(WorkerCommand::Retry));
        if retry {
            let state = runtime.state.lock().unwrap();
            if state.updates.installing() || state.recording_shortcut {
                continue;
            }
        }
        let should_toggle = matches!(command, Some(WorkerCommand::Toggle))
            || matches!(command, Some(WorkerCommand::ShortcutPressed))
                && (!prefs.hold_to_record || recording.is_none());
        let should_stop =
            matches!(command, Some(WorkerCommand::ShortcutReleased)) && prefs.hold_to_record;
        if recording.is_none() && should_toggle {
            if pending.is_some() || SavedRecording::latest(&recovery_directory).is_some() {
                continue;
            }
            let model = catalog().into_iter().find(|m| m.id == prefs.model).unwrap();
            if !runtime.paths.models.join(model.file).is_file() {
                runtime.error("Download the selected model in Models before recording.".into());
                continue;
            }
            // Reserve recording under the same lock used by the installer before opening audio.
            {
                let mut state = runtime.state.lock().unwrap();
                if state.updates.installing() || state.recording_shortcut {
                    continue;
                }
                state.status = "recording".into();
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
        } else if retry || recording.is_some() && (should_toggle || should_stop) {
            let (samples, saved, prefs) = if retry {
                match pending.take() {
                    Some((samples, saved)) => (samples, saved, prefs),
                    None => {
                        let Some(saved) = SavedRecording::latest(&recovery_directory) else {
                            continue;
                        };
                        match saved.samples() {
                            Ok(samples) => (samples, Some(saved), prefs),
                            Err(error) => {
                                runtime.error(error);
                                continue;
                            }
                        }
                    }
                }
            } else {
                let (capture, _, prefs) = recording.take().unwrap();
                match capture.finish() {
                    Ok(samples) => (samples, None, prefs),
                    Err(error) => {
                        runtime.error(error);
                        continue;
                    }
                }
            };
            runtime.update(|s| {
                s.status = "transcribing".into();
                s.message = "Transcribing locally… The first run also loads the model.".into();
            });
            let mut saved = saved;
            let result = (|| {
                if samples.len() < 3200
                    || samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>()
                        / (samples.len().max(1) as f64)
                        < 0.00000025
                {
                    return Ok(String::new());
                }
                if saved.is_none() {
                    saved = Some(SavedRecording::save(&recovery_directory, &samples)?);
                }
                let model = catalog().into_iter().find(|m| m.id == prefs.model).unwrap();
                let path = runtime.paths.models.join(model.file);
                let use_gpu = prefs.gpu && runtime.state.lock().unwrap().gpu_available;
                runtime.update(|s| s.gpu_fallback = false);
                let raw = engine.transcribe(
                    &samples,
                    saved.as_ref().unwrap(),
                    &path,
                    &prefs,
                    use_gpu,
                    || runtime.update(|s| s.gpu_fallback = true),
                )?;
                let text = openwhisper_core::process(&raw, &prefs.vocabulary, &prefs.snippets);
                if text.is_empty() {
                    return Err("No speech recognized".into());
                }
                saved.as_ref().unwrap().save_text(&text)?;
                Ok::<_, String>(text)
            })();
            match result {
                Ok(text) if text.is_empty() => {
                    if let Some(saved) = saved.as_ref() {
                        let _ = saved.remove();
                    }
                    runtime.update(|s| {
                        s.recovery_available =
                            SavedRecording::latest(&recovery_directory).is_some();
                        s.status = "idle".into();
                        s.message =
                            "No speech detected. Check your microphone and try again.".into();
                    });
                }
                Ok(text) => {
                    let copied =
                        integration::clipboard(&text, &mut runtime.clipboard.lock().unwrap());
                    let message = match copied {
                        Ok(_) => "Copied. Paste your text with Ctrl+V.".into(),
                        Err(ref e) => e.clone(),
                    };
                    runtime.update(|s| {
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
                    // Keep update installation blocked until clipboard, history, and paste finish.
                    if copied.is_ok() {
                        if let Some(saved) = saved.as_ref() {
                            let _ = saved.remove();
                        }
                    }
                    runtime.update(|s| {
                        s.status = "done".into();
                        s.recovery_available =
                            SavedRecording::latest(&recovery_directory).is_some();
                    });
                }
                Err(error) => {
                    // Retain RAM too when a full disk prevents creating the backup.
                    pending = Some((samples, saved));
                    runtime.update(|s| {
                        s.status = "error".into();
                        s.recovery_available = true;
                        s.message = format!("{error}. Your recording is retained. Retry transcription or discard it.");
                    });
                }
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
