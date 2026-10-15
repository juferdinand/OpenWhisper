# Audio quality hints

OpenWhisper checks the captured signal after Stop and can show one non-blocking hint:
very quiet audio, clipped/distorted samples, strong noise-like sound, or an apparently
limited frequency range. The hint explains what to try and links directly to microphone
settings. It does not change the audio, recognition, model choice, delivery or recovery policy.

The check applies to every microphone, including wired, built-in, USB and Bluetooth inputs.
A transport name alone does not establish signal quality, so Bluetooth is not automatically
rated as bad. The app does not estimate a recognition-accuracy percentage. These conservative
signal heuristics can miss problems and are not a calibrated speech-quality or SNR measurement.
A clean signal can still be recognized incorrectly, and a hint does not prove an incorrect result.

## Behavior and privacy

- Hints appear after processing, including a very quiet recording that returns to idle without
  transcription, or retained audio after a processing failure. They never stop dictation.
- Only the most relevant category is displayed. Dismiss hides it for the current recording;
  a new recording resets it. Selecting a history entry never associates it with the current hint.
- Cancelling or discarding the recording clears its hint. Retry reuses the owned assessment;
  restored Linux recovery audio is assessed again without changing recovery's silence policy.
- Signal measurements stay in the capture utility. Only a bounded category crosses IPC into the
  interface. No audio, device identity or numeric measurements are logged or added to history.
- Recordings remain unlimited and complete. Analysis shares the existing full-sample silence
  scan, yields for cancellation, uses fixed storage and computes at most 128 spectra per recording.

## Detection limits

The analyzed input is the existing prepared mono 16 kHz signal. This cannot recover clipping,
codec damage, missing syllables or frequency content already removed by a device or converter.
Leading silence and long pauses alone do not indicate poor capture and produce no warning.
Recordings shorter than one second do not have enough evidence for these general hints.

The current engineering thresholds are intentionally conservative and are not empirically
calibrated across physical microphones or languages:

| Hint | Required signal evidence |
| --- | --- |
| Very quiet | Even the three loudest supported 512-sample frames remain below approximately 0.004 RMS, excluding DC. This avoids treating long quiet pauses as quiet speech. |
| Clipping | Repeated near-full-scale flat plateaus, at least 32 supporting samples and 0.5% of non-silent frame samples. Isolated peaks are insufficient. |
| Noise-like sound | At least eight sampled audible frames; broadband spectral flatness in at least 80%, with a high and relatively stationary level floor. This is not an estimated speech-to-noise ratio. |
| Limited frequency range | At least eight sampled audible frames; diffuse upper-mid content with very little high-frequency energy in at least 80%. Low-pitched or formant-shaped harmonic sound alone is insufficient. |

Level evidence is scanned throughout the recording. Spectral frames are spread over its duration;
short localized noise/bandwidth problems can therefore be missed. Partial trailing frames are not
used for advisory decisions. The existing silence gate still validates and counts every sample.

The spectrum transform uses pinned MIT-licensed [fft.js 4.0.4](https://github.com/indutny/fft.js).
[RMS](https://librosa.org/doc/0.11.0/generated/librosa.feature.rms.html) and
[spectral flatness](https://librosa.org/doc/0.11.0/generated/librosa.feature.spectral_flatness.html)
are signal descriptors; those references do not validate OpenWhisper's chosen thresholds or
predict transcription accuracy.

## Automated scope

Synthetic tests cover quiet and silent input, clipped plateaus, clean full-scale peaks, isolated
clicks, broadband noise, band-limited and wideband signals, voiced/formant-shaped signals,
nonzero ambient pauses, arbitrary chunk boundaries, unchanged input, long ledgers and cancellation.
Coordinator and renderer tests cover delivery, recovery, retry, stale ownership, malformed categories,
dismissal, history isolation and English/German behavior on both platform interfaces. Physical
microphones, actual Bluetooth profile switching and per-device threshold calibration are separate
from this synthetic evidence; no physical-device coverage is implied.
