// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "WhisperFree",
    platforms: [.macOS(.v14)],
    targets: [
        // whisper.cpp als vorgebautes XCFramework (Metal + Accelerate). Wird von scripts/fetch-whisper.sh geladen.
        .binaryTarget(name: "whisper", path: "Vendor/whisper.xcframework"),

        // Reine Logik ohne System-Abhängigkeiten (testbar).
        .target(name: "WhisperFreeCore", path: "Sources/WhisperFreeCore"),

        .executableTarget(
            name: "WhisperFree",
            dependencies: ["WhisperFreeCore", "whisper"],
            path: "Sources/WhisperFree",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),

        .testTarget(name: "WhisperFreeCoreTests", dependencies: ["WhisperFreeCore"], path: "Tests/WhisperFreeCoreTests"),
    ]
)
