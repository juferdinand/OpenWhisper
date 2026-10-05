//! Explicit smoke test using 16 kHz mono f32le audio; never records a microphone.
use std::{env, path::Path, time::Instant};
use whisperfree_speech::SpeechEngine;

fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        return Err("Usage: transcribe MODEL PCM_F32LE whisper|parakeet [LANGUAGE] [gpu]".into());
    }
    if !["whisper", "parakeet"].contains(&args[3].as_str()) {
        return Err("Unknown model family".into());
    }
    let bytes = std::fs::read(&args[2]).map_err(|e| e.to_string())?;
    if bytes.len() % 4 != 0 {
        return Err("PCM length must be a multiple of four bytes".into());
    }
    let audio: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    if audio.is_empty() || audio.len() > 16000 * 120 || audio.iter().any(|v| !v.is_finite()) {
        return Err("Invalid audio".into());
    }
    let mut engine = SpeechEngine::new()?;
    let loaded = Instant::now();
    engine.load(
        Path::new(&args[1]),
        args[3] == "parakeet",
        args.get(5).is_some_and(|s| s == "gpu"),
    )?;
    eprintln!("Model load: {:.2}s", loaded.elapsed().as_secs_f32());
    for pass in 1..=2 {
        let started = Instant::now();
        let text =
            engine.transcribe(&audio, args.get(4).map(String::as_str).unwrap_or("en"), "")?;
        println!("{text}");
        eprintln!("Inference {pass}: {:.2}s", started.elapsed().as_secs_f32());
        if text.trim().is_empty() {
            return Err("Empty transcript".into());
        }
    }
    Ok(())
}
