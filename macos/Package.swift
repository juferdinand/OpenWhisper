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
