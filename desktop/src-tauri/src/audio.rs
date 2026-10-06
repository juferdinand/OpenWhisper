use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use audioadapter_buffers::direct::SequentialSlice;
use rubato::{Fft, FixedSync, Resampler};
use std::sync::{Arc, Mutex};

pub fn devices() -> Result<Vec<String>, String> {
    Ok(cpal::default_host()
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.description().ok().map(|description| description.name().to_owned()))
        .collect())
}

pub struct Capture {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    error: Arc<Mutex<Option<String>>>,
    rate: u32,
}

impl Capture {
    pub fn level(&self) -> f32 {
        let samples = self.samples.lock().unwrap();
        let tail = &samples[samples.len().saturating_sub(self.rate as usize / 20)..];
        (tail.iter().map(|v| v * v).sum::<f32>() / tail.len().max(1) as f32)
            .sqrt()
            .mul_add(8.0, 0.0)
            .clamp(0.0, 1.0)
    }
    pub fn start(name: &str) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = if name.is_empty() {
            host.default_input_device()
        } else {
            host.input_devices()
                .map_err(|e| e.to_string())?
                .find(|d| d.description().is_ok_and(|description| description.name() == name))
        }
        .ok_or("Microphone unavailable. Select another input in Settings.")?;
        let supported = device.default_input_config().map_err(|e| e.to_string())?;
        let rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        let samples = Arc::new(Mutex::new(Vec::with_capacity(rate as usize * 10)));
        let error = Arc::new(Mutex::new(None));
        let config: cpal::StreamConfig = supported.clone().into();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => {
                input::<f32>(&device, &config, channels, samples.clone(), error.clone())?
            }
            cpal::SampleFormat::I16 => {
                input::<i16>(&device, &config, channels, samples.clone(), error.clone())?
            }
            cpal::SampleFormat::I32 => {
                input::<i32>(&device, &config, channels, samples.clone(), error.clone())?
            }
            cpal::SampleFormat::U16 => {
                input::<u16>(&device, &config, channels, samples.clone(), error.clone())?
            }
            format => return Err(format!("Unsupported microphone sample format: {format:?}")),
        };
        stream.play().map_err(|e| e.to_string())?;
        Ok(Self {
            stream,
            samples,
            error,
            rate,
        })
    }

    pub fn finish(self) -> Result<Vec<f32>, String> {
        drop(self.stream);
        if let Some(error) = self.error.lock().unwrap().take() {
            return Err(error);
        }
        resample(&self.samples.lock().unwrap(), self.rate)
    }
}

fn input<T: cpal::SizedSample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mut buffer = samples.lock().unwrap();
                for frame in data.chunks_exact(channels) {
                    let value =
                        frame.iter().map(|v| v.to_sample::<f32>()).sum::<f32>() / channels as f32;
                    buffer.push(if value.is_finite() {
                        value.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    });
                }
            },
            move |e| {
                *error.lock().unwrap() = Some(format!("Microphone disconnected or failed: {e}"))
            },
            None,
        )
        .map_err(|e| e.to_string())
}

pub fn resample(samples: &[f32], rate: u32) -> Result<Vec<f32>, String> {
    if rate == 0 {
        return Err("Invalid sample rate".into());
    }
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    if rate == 16000 {
        return Ok(samples.to_vec());
    }
    let mut resampler = Fft::<f32>::new(rate as usize, 16000, 1024, 1, FixedSync::Both)
        .map_err(|e| e.to_string())?;
    let input = SequentialSlice::new(samples, 1, samples.len()).map_err(|e| e.to_string())?;
    let mut result = resampler
        .process_all(&input, samples.len(), None)
        .map_err(|e| e.to_string())?
        .take_data();
    // Preserve the existing floor-rounded duration; Rubato trims delay and flushes the tail.
    result.truncate(samples.len() * 16000 / rate as usize);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampling_preserves_partial_chunks_and_long_recordings() {
        for rate in [8000, 44100, 48000, 96000] {
            for len in [1, 17, 1023, 1024, 1025, rate as usize * 130 + 17] {
                let input = vec![0.25; len];
                let output = resample(&input, rate).unwrap();
                assert_eq!(output.len(), len * 16000 / rate as usize, "{rate}: {len}");
                assert!(output.iter().all(|v| v.is_finite()));
                if output.len() > 320 {
                    assert!((output[output.len() / 2] - 0.25).abs() < 0.01);
                }
            }
        }
    }

    #[test]
    fn resampling_keeps_native_rate_and_empty_input() {
        assert!(resample(&[], 48000).unwrap().is_empty());
        assert!(resample(&[0.1], 0).is_err());
        assert_eq!(resample(&[0.1, -0.2], 16000).unwrap(), [0.1, -0.2]);
    }

    #[test]
    fn resampling_preserves_duration_and_voice_frequency() {
        for rate in [44100, 48000, 96000] {
            let input: Vec<f32> = (0..rate)
                .map(|n| (n as f32 * std::f32::consts::TAU * 440.0 / rate as f32).sin() * 0.5)
                .collect();
            let output = resample(&input, rate).unwrap();
            assert_eq!(output.len(), 16000);
            let crossings = output
                .windows(2)
                .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
                .count();
            assert!((438..=441).contains(&crossings), "{rate}: {crossings}");
            assert!(output.iter().all(|v| v.is_finite() && v.abs() < 0.6));
        }
    }
}
