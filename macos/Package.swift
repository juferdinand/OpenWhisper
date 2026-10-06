// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "WhisperFree",
    platforms: [.macOS(.v14)],
    targets: [
        // Prebuilt whisper.cpp XCFramework (Metal + Accelerate), downloaded by scripts/fetch-whisper.sh.
        .binaryTarget(name: "whisper", path: "Vendor/whisper.xcframework"),

        // Testable text processing, model catalog, and platform-specific update validation.
        .target(name: "WhisperFreeCore", path: "Sources/WhisperFreeCore"),
        // Input hardware changes can raise Objective-C exceptions in AVAudioEngine.
        .target(name: "WhisperFreeAudio", path: "Sources/WhisperFreeAudio",
                cSettings: [.unsafeFlags(["-fobjc-arc"])]),

        .executableTarget(
            name: "WhisperFree",
            dependencies: ["WhisperFreeCore", "WhisperFreeAudio", "whisper"],
            path: "Sources/WhisperFree",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),

        .testTarget(name: "WhisperFreeCoreTests", dependencies: ["WhisperFreeCore"], path: "Tests/WhisperFreeCoreTests"),
        .target(name: "AudioTestSupport", dependencies: ["WhisperFreeAudio"], path: "Tests/AudioTestSupport",
                cSettings: [.unsafeFlags(["-fobjc-arc"])]),
        .testTarget(name: "WhisperFreeAppTests", dependencies: ["WhisperFree", "AudioTestSupport"], path: "Tests/WhisperFreeAppTests"),
    ]
)
