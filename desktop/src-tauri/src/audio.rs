use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{FftFixedInOut, Resampler};
use std::sync::{Arc, Mutex};

pub fn devices() -> Result<Vec<String>, String> {
    Ok(cpal::default_host()
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
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
                .find(|d| d.name().ok().as_deref() == Some(name))
        }
        .ok_or("Microphone unavailable. Select another input in Settings.")?;
        let supported = device.default_input_config().map_err(|e| e.to_string())?;
        let rate = supported.sample_rate().0;
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
    let mut resampler =
        FftFixedInOut::<f32>::new(rate as usize, 16000, 1024, 1).map_err(|e| e.to_string())?;
    let expected = samples.len() * 16000 / rate as usize;
    let delay = resampler.output_delay();
    let mut result = Vec::new();
    let mut rest = samples;
    let chunk = resampler.input_frames_next();
    while rest.len() >= chunk {
        result.extend_from_slice(
            &resampler
                .process(&[&rest[..chunk]], None)
                .map_err(|e| e.to_string())?[0],
        );
        rest = &rest[chunk..];
    }
    if !rest.is_empty() {
        result.extend_from_slice(
            &resampler
                .process_partial(Some(&[rest]), None)
                .map_err(|e| e.to_string())?[0],
        );
    }
    while result.len() < expected + delay {
        result.extend_from_slice(
            &resampler
                .process_partial::<&[f32]>(None, None)
                .map_err(|e| e.to_string())?[0],
        );
    }
    Ok(result[delay..delay + expected].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
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
