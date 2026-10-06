#import "AudioTestSupport.h"
#import "OpenWhisperAudio.h"

// Duck-typed stand-ins exercise AVAudioEngine's exception boundary without input hardware.
@interface FailingInput : NSObject
@end
@implementation FailingInput
- (AVAudioFormat *)inputFormatForBus:(AVAudioNodeBus)bus {
    return [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:1];
}
- (void)installTapOnBus:(AVAudioNodeBus)bus bufferSize:(AVAudioFrameCount)size
                format:(AVAudioFormat *)format block:(AVAudioNodeTapBlock)block {
    [NSException raise:@"com.apple.coreaudio.avfaudio" format:@"Synthetic device disappearance"];
}
- (void)removeTapOnBus:(AVAudioNodeBus)bus {
    [NSException raise:@"com.apple.coreaudio.avfaudio" format:@"Synthetic stale input graph"];
}
@end

@interface FailingEngine : NSObject
@property BOOL stopped;
@end
@implementation FailingEngine
- (AVAudioInputNode *)inputNode { return (AVAudioInputNode *)[FailingInput new]; }
- (void)stop { self.stopped = YES; }
@end

BOOL WFTestAudioStartException(void) {
    FailingEngine *engine = [FailingEngine new];
    NSError *error = nil;
    BOOL started = WFStartAudioEngine((AVAudioEngine *)engine, ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {}, &error);
    return !started && error.code == 3 && engine.stopped;
}

BOOL WFTestAudioStopException(void) {
    FailingEngine *engine = [FailingEngine new];
    NSError *error = nil;
    BOOL stopped = WFStopAudioEngine((AVAudioEngine *)engine, &error);
    return !stopped && error.code == 2 && engine.stopped;
}
