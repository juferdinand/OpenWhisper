# Experimental meeting transcription

This feature is under development on `feature/conference-transcription`. It is not part of the
0.5.7 release and its speaker-label accuracy has not been validated in real meetings.

## Current workflow

Choose **Meeting** under **Session type**, select a local speech model, then start and stop a
recording as usual. OpenWhisper transcribes the saved recording after Stop and copies the result
to the clipboard. The transcript appears in the workspace and follows the existing local history
setting. Each detected speech turn is prefixed with a timestamp and a suggested label, for example
`[00:12] Speaker A: ...`.

Recording and speech recognition use the existing local capture and model pipeline. Meeting mode
does not send audio or transcript text to the optional text-model connections. It does not paste
the transcript into the active application, even when automatic paste is selected for dictation.
Audio remains in memory while recording. On Linux, stopped audio uses the existing private
recovery file until transcription and clipboard delivery succeed.

## Speaker labels and limits

Speaker grouping is an experimental local acoustic heuristic. It detects pauses, compares
MFCC-like spectral summaries across speech turns and groups similar turns as Speaker A, B, C or D.
It is not a trained speaker-diarization model, does not identify people by name and has no
enrollment step. Treat the labels as suggestions and edit them after copying the transcript.

The feature currently records one selected input. Choose a source that contains every participant.
A microphone can miss remote speakers when they are heard only through headphones. Overlapping
voices are not separated, and long uninterrupted turns may be split into separate segments.
Transcription is produced after Stop; this version does not show a live meeting transcript.

## Development validation

The implementation uses the existing Electron recording build path and is isolated on its feature
branch. TypeScript and build checks are required before review; package/runtime validation remains
outstanding. No real microphone, meeting recording or physical-device check is performed as part
of unattended validation.
