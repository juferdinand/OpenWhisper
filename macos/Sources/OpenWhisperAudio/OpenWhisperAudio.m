#import "OpenWhisperAudio.h"

static NSError *inputError(NSInteger code) {
    // Do not retain device names or exception reasons in diagnostics.
    return [NSError errorWithDomain:@"io.github.whisperfree.audio" code:code
                          userInfo:@{NSLocalizedDescriptionKey:
                              @"Microphone unavailable or changed. Check your input device and try again."}];
}

BOOL WFStopAudioEngine(AVAudioEngine *engine, NSError **error) {
    BOOL stopped = YES;
    @try { [engine.inputNode removeTapOnBus:0]; }
    @catch (NSException *exception) { stopped = NO; }
    @try { [engine stop]; }
    @catch (NSException *exception) { stopped = NO; }
    if (!stopped && error) *error = inputError(2);
    return stopped;
}

BOOL WFStartAudioEngine(AVAudioEngine *engine, AVAudioNodeTapBlock tap, NSError **error) {
    @try {
        AVAudioInputNode *input = engine.inputNode;
        AVAudioFormat *hardware = [input inputFormatForBus:0];
        if (hardware.sampleRate <= 0 || hardware.channelCount == 0) {
            if (error) *error = inputError(1);
            return NO;
        }
        // Let the engine choose its current format instead of pinning a stale device format.
        [input installTapOnBus:0 bufferSize:1024 format:nil block:tap];
        [engine prepare];
        if ([engine startAndReturnError:error]) return YES;
    } @catch (NSException *exception) {
        if (error) *error = inputError(3);
    }
    WFStopAudioEngine(engine, nil);
    return NO;
}
