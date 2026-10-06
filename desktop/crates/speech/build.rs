use std::{env, path::PathBuf};
fn main() {
    let desktop = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let source = desktop.join("vendor/whisper.cpp");
    assert!(
        source.join(".source-revision").exists(),
        "Run bash desktop/scripts/fetch-native.sh first"
    );
    let mut config = cmake::Config::new(&source);
    config
        .profile("Release")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .define("WHISPER_BUILD_TESTS", "OFF")
        .define("WHISPER_BUILD_EXAMPLES", "OFF")
        .define("GGML_NATIVE", "OFF")
        .define("GGML_OPENMP", "OFF")
        .define("GGML_BACKEND_DL", "OFF")
        .define("GGML_CCACHE", "OFF");
    // A portable CPU baseline. GPU acceleration is an optional, separately tested build.
    for flag in ["SSE42", "AVX", "AVX2", "BMI2", "FMA", "F16C"] {
        config.define(format!("GGML_{flag}"), "OFF");
    }
    let vulkan = env::var_os("CARGO_FEATURE_VULKAN").is_some();
    config.define("GGML_VULKAN", if vulkan { "ON" } else { "OFF" });
    let built = config.build();
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .file(desktop.join("native/speech_bridge.cpp"))
        .include(source.join("include"))
        .include(source.join("ggml/include"))
        .compile("whisperfree_bridge");
    println!(
        "cargo:rustc-link-search=native={}",
        built.join("lib").display()
    );
    for lib in ["whisper", "parakeet", "ggml", "ggml-cpu", "ggml-base"] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    if vulkan {
        println!("cargo:rustc-link-lib=static=ggml-vulkan");
        println!("cargo:rustc-link-lib=vulkan");
    }
    println!("cargo:rustc-link-lib=stdc++");
    println!("cargo:rustc-link-lib=pthread");
    println!("cargo:rustc-link-lib=dl");
    println!("cargo:rustc-link-lib=m");
    println!(
        "cargo:rerun-if-changed={}",
        desktop.join("native/speech_bridge.cpp").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        desktop.join("native/whisper-source.json").display()
    );
}
