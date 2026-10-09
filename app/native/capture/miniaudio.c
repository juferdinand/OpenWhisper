/* Compile the exact pinned source separately; no native diagnostics are enabled. */
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include <stdint.h>

/* The pinned Pulse backend discards PA holes/read errors without a device error notification.
   Preserve server-defined hole duration as zero PCM; fail only on malformed/read/drop errors. */
extern void wf_capture_signal_failure(void* owner, int reason);
typedef void (*wf_fragment_consumer)(void* owner, const void* input, ma_uint32 frames);

/* Shared with the synthetic path: no context, stream, device or audio source is opened here. */
int wf_capture_visit_fragment(const void* input, size_t bytes, ma_format format, ma_uint32 channels,
                              void* owner, wf_fragment_consumer consume)
{
    const ma_uint32 frame_size = ma_get_bytes_per_frame(format, channels);
    float silence[4096];
    ma_uint32 frames;
    if (frame_size == 0 || frame_size > sizeof(silence) || bytes == 0 || bytes % frame_size ||
        bytes / frame_size > UINT32_MAX) return -1;
    frames = (ma_uint32)(bytes / frame_size);
    if (input != NULL) { consume(owner, input, frames); return 0; }
    /* NULL/nonzero is a documented Pulse hole, not a terminal stream failure. */
    {
        const ma_uint32 capacity = (ma_uint32)(sizeof(silence) / frame_size);
        ma_silence_pcm_frames(silence, capacity, format, channels);
        while (frames != 0) {
            const ma_uint32 block = frames < capacity ? frames : capacity;
            consume(owner, silence, block);
            frames -= block;
        }
    }
    return 0;
}
static void wf_emit_device(void* owner, const void* input, ma_uint32 frames)
{
    ma_device* device = (ma_device*)owner;
    if (ma_device_handle_backend_data_callback(device, NULL, input, frames) != MA_SUCCESS)
        wf_capture_signal_failure(device->pUserData, 2);
}
static void wf_guarded_read(ma_pa_stream* stream, size_t bytes, void* data)
{
    ma_device* device = (ma_device*)data;
    (void)bytes;
    /* This small read loop follows pinned ma_device_on_read__pulse, with explicit errors for
       every fragment/hole. Peeking only the first fragment would miss a later hole in the same callback. */
    for (;;) {
        const ma_uint32 state = ma_device_get_state(device);
        const void* input = NULL;
        size_t count = 0;
        if (state != ma_device_state_started) return;
        if (((ma_pa_stream_peek_proc)device->pContext->pulse.pa_stream_peek)(stream, &input, &count) < 0) {
            wf_capture_signal_failure(device->pUserData, 0);
            return;
        }
        if (count == 0) return;
        if (wf_capture_visit_fragment(input, count, device->capture.internalFormat,
                                      device->capture.internalChannels, device, wf_emit_device) != 0)
            wf_capture_signal_failure(device->pUserData, 2);
        if (((ma_pa_stream_drop_proc)device->pContext->pulse.pa_stream_drop)(stream) < 0) {
            wf_capture_signal_failure(device->pUserData, 3);
            return;
        }
    }
}
void wf_capture_install_read_guard(ma_device* device)
{
    ((ma_pa_stream_set_read_callback_proc)device->pContext->pulse.pa_stream_set_read_callback)(
        (ma_pa_stream*)device->pulse.pStreamCapture, wf_guarded_read, device);
}
