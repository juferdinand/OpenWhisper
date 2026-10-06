// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "OpenWhisper",
    platforms: [.macOS(.v14)],
    targets: [
        // Prebuilt whisper.cpp XCFramework (Metal + Accelerate), downloaded by scripts/fetch-whisper.sh.
        .binaryTarget(name: "whisper", path: "Vendor/whisper.xcframework"),

        // Testable text processing, model catalog, and platform-specific update validation.
        .target(name: "OpenWhisperCore", path: "Sources/OpenWhisperCore"),
        // Input hardware changes can raise Objective-C exceptions in AVAudioEngine.
        .target(name: "OpenWhisperAudio", path: "Sources/OpenWhisperAudio",
                cSettings: [.unsafeFlags(["-fobjc-arc"])]),

        .executableTarget(
            name: "OpenWhisper",
            dependencies: ["OpenWhisperCore", "OpenWhisperAudio", "whisper"],
            path: "Sources/OpenWhisper",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),

        .testTarget(name: "OpenWhisperCoreTests", dependencies: ["OpenWhisperCore"], path: "Tests/OpenWhisperCoreTests"),
        .target(name: "AudioTestSupport", dependencies: ["OpenWhisperAudio"], path: "Tests/AudioTestSupport",
                cSettings: [.unsafeFlags(["-fobjc-arc"])]),
        .testTarget(name: "OpenWhisperAppTests", dependencies: ["OpenWhisper", "AudioTestSupport"], path: "Tests/OpenWhisperAppTests"),
    ]
)
