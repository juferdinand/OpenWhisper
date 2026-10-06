use std::ops::Range;

pub const SAMPLE_RATE: usize = 16_000;
pub const MAX_CHUNK_SAMPLES: usize = 30 * SAMPLE_RATE;
pub const MIN_CHUNK_SAMPLES: usize = SAMPLE_RATE;

/// Bound inference memory independently of recording duration. Prefer a quiet boundary
/// near the end of the window, without dropping, overlapping, or repeating any samples.
pub fn next_chunk(samples: &[f32], start: usize, maximum: usize) -> Range<usize> {
    let remaining = samples.len() - start;
    let maximum = maximum.clamp(MIN_CHUNK_SAMPLES, MAX_CHUNK_SAMPLES);
    if remaining <= maximum {
        return start..samples.len();
    }
    // Leave at least one second for the final chunk, including just-over-window inputs.
    let tail = MIN_CHUNK_SAMPLES.min(maximum / 2);
    let end = (start + maximum).min(samples.len() - tail);
    let window = SAMPLE_RATE / 10;
    let search = (maximum / 6).min(5 * SAMPLE_RATE);
    let first = (end - search).max(start + window);
    let mut best_end = end;
    let mut best_energy = f64::INFINITY;
    for boundary in (first..=end).step_by(window / 2) {
        let energy = samples[boundary - window..boundary + window / 2]
            .iter()
            .map(|&v| f64::from(v).powi(2))
            .sum::<f64>();
        // Equal energies prefer later boundaries, avoiding tiny chunks during silence.
        if energy <= best_energy {
            best_energy = energy;
            best_end = boundary;
        }
    }
    start..best_end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_recordings_are_covered_once_even_after_window_reduction() {
        for length in [
            0,
            1,
            SAMPLE_RATE,
            MAX_CHUNK_SAMPLES,
            MAX_CHUNK_SAMPLES + 1,
            7 * 60 * SAMPLE_RATE + 17,
        ] {
            let samples = vec![0.2; length];
            for maximum in [MAX_CHUNK_SAMPLES, 7 * SAMPLE_RATE, MIN_CHUNK_SAMPLES] {
                let mut start = 0;
                while start < samples.len() {
                    let range = next_chunk(&samples, start, maximum);
                    assert_eq!(range.start, start);
                    assert!(range.end > start && range.len() <= maximum);
                    start = range.end;
                }
                assert_eq!(start, length);
            }
        }
    }

    #[test]
    fn boundaries_prefer_speech_pauses_and_keep_a_usable_tail() {
        let mut samples = vec![0.2; 61 * SAMPLE_RATE];
        samples[27 * SAMPLE_RATE..28 * SAMPLE_RATE].fill(0.0);
        let range = next_chunk(&samples, 0, MAX_CHUNK_SAMPLES);
        assert!((27 * SAMPLE_RATE..28 * SAMPLE_RATE).contains(&range.end));
        let samples = vec![0.0; MAX_CHUNK_SAMPLES + 1];
        let range = next_chunk(&samples, 0, MAX_CHUNK_SAMPLES);
        assert!(samples.len() - range.end >= MIN_CHUNK_SAMPLES);
    }
}
