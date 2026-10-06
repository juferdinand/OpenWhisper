//! Inference runs in a disposable process. Native aborts and allocation failures must
//! never terminate capture/UI or destroy the only copy of a stopped recording.
use crate::settings::Preferences;
use openwhisper_speech::{chunks, SpeechEngine};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize)]
#[serde(tag = "command")]
enum Request {
    Discover,
    Transcribe {
        model: PathBuf,
        parakeet: bool,
        gpu: bool,
        audio: PathBuf,
        byte_offset: u64,
        count: usize,
        language: String,
        vocabulary: String,
    },
}

#[derive(Default, Serialize, Deserialize)]
struct Reply {
    text: Option<String>,
    gpu: Option<String>,
    error: Option<String>,
}

/// Invoked before GTK/Tauri initialization. All native speech calls stay on this thread.
pub fn helper() -> Result<(), String> {
    // Prefer this disposable process to the UI if the kernel has to reclaim memory.
    let _ = fs::write("/proc/self/oom_score_adj", "500");
    let mut engine = SpeechEngine::new()?;
    let input = std::io::stdin();
    let mut output = std::io::stdout().lock();
    for line in input.lock().lines() {
        let request: Request =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let result = match request {
            Request::Discover => Ok(Reply {
                gpu: engine.gpu_name(),
                ..Reply::default()
            }),
            Request::Transcribe {
                model,
                parakeet,
                gpu,
                audio,
                byte_offset,
                count,
                language,
                vocabulary,
            } => (|| {
                if count == 0 || count > chunks::MAX_CHUNK_SAMPLES {
                    return Err("Invalid inference window".into());
                }
                let mut file = File::open(audio).map_err(|e| e.to_string())?;
                file.seek(SeekFrom::Start(byte_offset))
                    .map_err(|e| e.to_string())?;
                let mut bytes = vec![0; count * 4];
                file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                let samples: Vec<f32> = bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| f32::from_le_bytes(*b))
                    .collect();
                engine.load(&model, parakeet, gpu)?;
                engine
                    .transcribe(&samples, &language, &vocabulary)
                    .map(|text| Reply {
                        text: Some(text),
                        ..Reply::default()
                    })
            })(),
        };
        let reply = result.unwrap_or_else(|error| Reply {
            error: Some(error),
            ..Reply::default()
        });
        serde_json::to_writer(&mut output, &reply).map_err(|e| e.to_string())?;
        output
            .write_all(b"\n")
            .and_then(|_| output.flush())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Explicit native regression entry point using a supplied file; never opens capture.
pub fn smoke_test(arguments: &[String]) -> Result<(), String> {
    if arguments.len() != 6 || !["cpu", "gpu"].contains(&arguments[5].as_str()) {
        return Err(
            "Usage: --transcription-smoke-test MODEL_ID MODEL_FILE PCM_F32LE cpu|gpu".into(),
        );
    }
    let model = openwhisper_core::catalog()
        .into_iter()
        .find(|m| m.id == arguments[2])
        .ok_or("Unknown model")?;
    let source = Path::new(&arguments[4]);
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let (frames, remainder) = bytes.as_chunks::<4>();
    if !remainder.is_empty() {
        return Err("Invalid PCM length".into());
    }
    let samples: Vec<f32> = frames.iter().map(|b| f32::from_le_bytes(*b)).collect();
    let directory = source.with_extension("recovery");
    let saved = SavedRecording::save(&directory, &samples)?;
    let prefs = Preferences {
        model: model.id,
        language: "auto".into(),
        ..Preferences::default()
    };
    let mut service = Service::new()?;
    let use_gpu = arguments[5] == "gpu";
    if use_gpu && service.gpu_name().is_none() {
        return Err("No hardware GPU available".into());
    }
    let text = service.transcribe(
        &samples,
        &saved,
        Path::new(&arguments[3]),
        &prefs,
        use_gpu,
        || {},
    )?;
    if text.is_empty() {
        return Err("Empty transcript".into());
    }
    crate::settings::private_write(&source.with_extension("txt"), text.as_bytes())?;
    saved.remove()?;
    fs::remove_dir(directory).map_err(|e| e.to_string())?;
    Ok(())
}

struct SpeechProcess {
    child: Child,
    input: BufWriter<ChildStdin>,
    output: mpsc::Receiver<Result<String, String>>,
    reader: Option<JoinHandle<()>>,
}

impl SpeechProcess {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not start speech process: {e}"))?;
        let input = BufWriter::new(child.stdin.take().ok_or("Speech input unavailable")?);
        let output = BufReader::new(child.stdout.take().ok_or("Speech output unavailable")?);
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in output.lines() {
                if sender.send(line.map_err(|e| e.to_string())).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            output: receiver,
            reader: Some(reader),
        })
    }

    fn request(&mut self, request: &Request) -> Result<Reply, String> {
        self.request_with_timeout(request, Duration::from_secs(10 * 60))
    }

    fn request_with_timeout(
        &mut self,
        request: &Request,
        timeout: Duration,
    ) -> Result<Reply, String> {
        let result = (|| {
            serde_json::to_writer(&mut self.input, request).map_err(|e| e.to_string())?;
            self.input
                .write_all(b"\n")
                .and_then(|_| self.input.flush())
                .map_err(|e| e.to_string())?;
            // This is an inference watchdog, never a recording-duration limit.
            let line = self
                .output
                .recv_timeout(timeout)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => "The speech process did not respond",
                    mpsc::RecvTimeoutError::Disconnected => {
                        "The speech process stopped unexpectedly"
                    }
                })??;
            let reply: Reply = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if let Some(error) = reply.error.as_ref() {
                return Err(error.clone());
            }
            Ok(reply)
        })();
        // Do not log requests, replies, audio, or vocabulary.
        result
    }
}

impl Drop for SpeechProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub struct Service {
    executable: PathBuf,
    process: Option<SpeechProcess>,
}

impl Service {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            executable: std::env::current_exe().map_err(|e| e.to_string())?,
            process: None,
        })
    }

    fn request(&mut self, request: &Request) -> Result<Reply, String> {
        if self.process.is_none() {
            let mut command = Command::new(&self.executable);
            command.arg("--linux-speech-helper");
            self.process = Some(SpeechProcess::spawn(command)?);
        }
        let result = self.process.as_mut().unwrap().request(request);
        if result.is_err() {
            self.process.take();
        }
        result
    }

    pub fn gpu_name(&mut self) -> Option<String> {
        self.request(&Request::Discover).ok().and_then(|r| r.gpu)
    }

    pub fn transcribe(
        &mut self,
        samples: &[f32],
        saved: &SavedRecording,
        model: &Path,
        preferences: &Preferences,
        use_gpu: bool,
        mut fallback: impl FnMut(),
    ) -> Result<String, String> {
        let parakeet = openwhisper_core::catalog()
            .iter()
            .any(|m| m.id == preferences.model && m.family == "parakeet");
        adaptive(samples, use_gpu, |range, gpu| {
            if use_gpu && !gpu {
                fallback();
            }
            self.request(&Request::Transcribe {
                model: model.to_path_buf(),
                parakeet,
                gpu,
                audio: saved.path.clone(),
                byte_offset: saved.offset + range.start as u64 * 4,
                count: range.len(),
                language: preferences.language.clone(),
                vocabulary: preferences.vocabulary.clone(),
            })?
            .text
            .ok_or_else(|| "Speech process returned no result".into())
        })
    }
}

/// Retry only the unfinished range. Smaller windows also apply to CPU failures;
/// a manual CPU choice is never overridden. Exhaustion preserves the backup.
fn adaptive(
    samples: &[f32],
    use_gpu: bool,
    mut infer: impl FnMut(std::ops::Range<usize>, bool) -> Result<String, String>,
) -> Result<String, String> {
    let mut maximum = chunks::MAX_CHUNK_SAMPLES;
    let mut gpu = use_gpu;
    let mut start = 0;
    let mut text = String::new();
    while start < samples.len() {
        let range = chunks::next_chunk(samples, start, maximum);
        match infer(range.clone(), gpu) {
            Ok(part) => {
                let part = part.trim();
                if !part.is_empty() {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(part);
                }
                start = range.end;
            }
            Err(error) => {
                if maximum > chunks::MIN_CHUNK_SAMPLES {
                    maximum = (maximum / 2).max(chunks::MIN_CHUNK_SAMPLES);
                } else if gpu {
                    gpu = false;
                    maximum = chunks::MAX_CHUNK_SAMPLES;
                } else {
                    return Err(error);
                }
            }
        }
    }
    Ok(text)
}

/// Private, atomic WAV backup. Failed recordings survive process exits and retries.
/// RF64 handles large recordings without introducing a recording-duration cutoff.
#[derive(Clone)]
pub struct SavedRecording {
    pub path: PathBuf,
    offset: u64,
}

impl SavedRecording {
    pub fn save(directory: &Path, samples: &[f32]) -> Result<Self, String> {
        if samples.is_empty() || samples.iter().any(|s| !s.is_finite()) {
            return Err("Invalid audio samples".into());
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|e| e.to_string())?;
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let path = directory.join(format!("recording-{time:020}-{}.wav", uuid::Uuid::new_v4()));
        let temporary = path.with_extension("tmp");
        let (header, offset) = wav_header(samples.len() as u64);
        let result = (|| {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            let mut output = BufWriter::new(file);
            output.write_all(&header)?;
            for block in samples.chunks(4096) {
                let mut bytes = [0; 4096 * 4];
                for (value, dest) in block.iter().zip(bytes.as_chunks_mut::<4>().0.iter_mut()) {
                    dest.copy_from_slice(&value.to_le_bytes());
                }
                output.write_all(&bytes[..block.len() * 4])?;
            }
            output.flush()?;
            output.get_ref().sync_all()?;
            fs::rename(&temporary, &path)?;
            File::open(directory)?.sync_all()
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(temporary);
            return Err(format!("Could not save the recording: {error}"));
        }
        Ok(Self { path, offset })
    }

    pub fn latest(directory: &Path) -> Option<Self> {
        let mut paths: Vec<_> = fs::read_dir(directory)
            .ok()?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|s| s == "wav"))
            .collect();
        paths.sort();
        paths
            .into_iter()
            .rev()
            .find_map(|path| Self::open(path).ok())
    }

    pub fn open(path: PathBuf) -> Result<Self, String> {
        let mut file = File::open(&path).map_err(|e| e.to_string())?;
        let mut header = [0; 44];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        let offset = if &header[..4] == b"RIFF" {
            44
        } else if &header[..4] == b"RF64" {
            80
        } else {
            return Err("Unsupported recording backup".into());
        };
        if offset == 80 {
            let mut rest = [0; 36];
            file.read_exact(&mut rest).map_err(|e| e.to_string())?;
        }
        // Compare the complete header with the format we write; reject partial/unrelated files.
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length < offset || (length - offset) % 4 != 0 {
            return Err("Incomplete recording backup".into());
        }
        let (expected, expected_offset) = wav_header((length - offset) / 4);
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut actual = vec![0; expected.len()];
        file.read_exact(&mut actual).map_err(|e| e.to_string())?;
        if offset != expected_offset || actual != expected {
            return Err("Invalid recording backup".into());
        }
        Ok(Self { path, offset })
    }

    pub fn samples(&self) -> Result<Vec<f32>, String> {
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        let count =
            usize::try_from((file.metadata().map_err(|e| e.to_string())?.len() - self.offset) / 4)
                .map_err(|_| "Not enough memory to read the recording")?;
        let mut samples = Vec::new();
        samples
            .try_reserve_exact(count)
            .map_err(|_| "Not enough memory to read the recording")?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let mut input = BufReader::new(file);
        let mut bytes = [0; 4096 * 4];
        while samples.len() < count {
            let block = (count - samples.len()).min(4096);
            input
                .read_exact(&mut bytes[..block * 4])
                .map_err(|e| e.to_string())?;
            for value in bytes[..block * 4].as_chunks::<4>().0.iter() {
                let value = f32::from_le_bytes(*value);
                if !value.is_finite() {
                    return Err("Invalid audio samples".into());
                }
                samples.push(value);
            }
        }
        Ok(samples)
    }

    pub fn save_text(&self, text: &str) -> Result<(), String> {
        crate::settings::private_write(&self.path.with_extension("txt"), text.as_bytes())
    }

    pub fn remove(&self) -> Result<(), String> {
        fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(self.path.with_extension("txt"));
        Ok(())
    }
}

fn wav_header(samples: u64) -> (Vec<u8>, u64) {
    let size = samples * 4;
    let mut header = Vec::new();
    let offset = if size <= u64::from(u32::MAX) - 36 {
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&((size + 36) as u32).to_le_bytes());
        header.extend_from_slice(b"WAVE");
        44
    } else {
        header.extend_from_slice(b"RF64\xff\xff\xff\xffWAVEds64\x1c\x00\x00\x00");
        header.extend_from_slice(&(size + 72).to_le_bytes());
        header.extend_from_slice(&size.to_le_bytes());
        header.extend_from_slice(&samples.to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes());
        80
    };
    header.extend_from_slice(b"fmt \x10\x00\x00\x00\x03\x00\x01\x00");
    header.extend_from_slice(&(chunks::SAMPLE_RATE as u32).to_le_bytes());
    header.extend_from_slice(&(chunks::SAMPLE_RATE as u32 * 4).to_le_bytes());
    header.extend_from_slice(b"\x04\x00\x20\x00data");
    header.extend_from_slice(&(if offset == 80 { u32::MAX } else { size as u32 }).to_le_bytes());
    (header, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn allocation_failures_reduce_windows_on_both_backends_without_losing_completed_ranges() {
        let samples = vec![0.1; 67 * chunks::SAMPLE_RATE];
        let mut covered = 0;
        let mut failures = 0;
        let text = adaptive(&samples, true, |range, gpu| {
            assert_eq!(range.start, covered);
            if gpu || range.len() > 2 * chunks::SAMPLE_RATE {
                failures += 1;
                return Err("Synthetic allocation failure".into());
            }
            covered = range.end;
            Ok("part".into())
        })
        .unwrap();
        assert!(failures > 6);
        assert_eq!(covered, samples.len());
        assert!(!text.is_empty());
    }

    #[test]
    fn cpu_choice_and_completed_text_survive_a_later_failure() {
        let samples = vec![0.1; 61 * chunks::SAMPLE_RATE];
        let mut covered = 0;
        let mut calls = 0;
        let text = adaptive(&samples, false, |range, gpu| {
            assert!(!gpu);
            assert_eq!(range.start, covered);
            calls += 1;
            if covered > 0 && range.len() > 4 * chunks::SAMPLE_RATE {
                return Err("Failure".into());
            }
            covered = range.end;
            Ok(if calls == 1 { "first" } else { "later" }.into())
        })
        .unwrap();
        assert_eq!(covered, samples.len());
        assert_eq!(text.split_whitespace().filter(|&s| s == "first").count(), 1);
        let mut attempts = 0;
        assert!(adaptive(&samples, false, |_, _| {
            attempts += 1;
            Err("Failure".into())
        })
        .is_err());
        assert_eq!(attempts, 6);
    }

    #[test]
    fn speech_process_death_returns_an_error_to_the_surviving_parent() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read line; kill -KILL $$"]);
        let mut process = SpeechProcess::spawn(command).unwrap();
        assert!(process.request(&Request::Discover).is_err());
    }

    #[test]
    fn an_unresponsive_speech_process_returns_control_without_losing_audio() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read line; exec sleep 2"]);
        let mut process = SpeechProcess::spawn(command).unwrap();
        assert!(process
            .request_with_timeout(&Request::Discover, Duration::from_millis(20))
            .is_err());
    }

    #[test]
    fn backups_are_private_exact_and_survive_restart_until_explicit_removal() {
        let directory =
            std::env::temp_dir().join(format!("openwhisper-audio-{}", uuid::Uuid::new_v4()));
        let samples = vec![-0.25, 0.0, 0.75, 0.125];
        let saved = SavedRecording::save(&directory, &samples).unwrap();
        assert_eq!(
            fs::metadata(&saved.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        saved.save_text("public test fixture").unwrap();
        drop(saved);
        let saved = SavedRecording::latest(&directory).unwrap();
        assert_eq!(saved.samples().unwrap(), samples);
        saved.remove().unwrap();
        assert!(SavedRecording::latest(&directory).is_none());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn rf64_headers_do_not_cap_recording_length_and_incomplete_backups_are_rejected() {
        let (header, offset) = wav_header(u64::from(u32::MAX));
        assert_eq!(&header[..4], b"RF64");
        assert_eq!(header.len() as u64, offset);
        assert_eq!(offset, 80);
        let directory =
            std::env::temp_dir().join(format!("openwhisper-audio-{}", uuid::Uuid::new_v4()));
        let saved = SavedRecording::save(&directory, &[0.1; 16]).unwrap();
        OpenOptions::new()
            .write(true)
            .open(&saved.path)
            .unwrap()
            .set_len(45)
            .unwrap();
        assert!(SavedRecording::open(saved.path.clone()).is_err());
        assert!(SavedRecording::latest(&directory).is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
