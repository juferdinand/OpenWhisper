#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN
// Keep exception handling inside Objective-C; Swift do/catch cannot catch NSException.
BOOL WFStartAudioEngine(AVAudioEngine *engine, AVAudioNodeTapBlock tap,
                       NSError * _Nullable * _Nullable error) NS_SWIFT_NOTHROW;
BOOL WFStopAudioEngine(AVAudioEngine *engine,
                      NSError * _Nullable * _Nullable error) NS_SWIFT_NOTHROW;
NS_ASSUME_NONNULL_END
