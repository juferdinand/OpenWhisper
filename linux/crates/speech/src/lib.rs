use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    ptr::NonNull,
};

pub mod chunks;

extern "C" {
    fn wf_speech_gpu_name() -> *const c_char;
    fn wf_speech_create() -> *mut c_void;
    fn wf_speech_destroy(context: *mut c_void);
    fn wf_speech_error(context: *mut c_void) -> *const c_char;
    fn wf_speech_load(context: *mut c_void, path: *const c_char, parakeet: bool, gpu: bool) -> i32;
    fn wf_speech_transcribe(
        context: *mut c_void,
        samples: *const f32,
        count: i32,
        language: *const c_char,
        prompt: *const c_char,
    ) -> *const c_char;
}

/// Confined to the speech worker thread; contexts must never be used concurrently.
pub struct SpeechEngine(NonNull<c_void>);
impl SpeechEngine {
    /// Called on the owning worker thread; backend discovery can initialize Vulkan.
    pub fn gpu_name(&self) -> Option<String> {
        let name = unsafe { wf_speech_gpu_name() };
        if name.is_null() {
            None
        } else {
            Some(
                unsafe { CStr::from_ptr(name) }
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }
    pub fn new() -> Result<Self, String> {
        NonNull::new(unsafe { wf_speech_create() })
            .map(Self)
            .ok_or_else(|| "Could not allocate speech engine".into())
    }
    fn error(&self) -> String {
        unsafe { CStr::from_ptr(wf_speech_error(self.0.as_ptr())) }
            .to_string_lossy()
            .into_owned()
    }
    pub fn load(&mut self, path: &Path, parakeet: bool, gpu: bool) -> Result<(), String> {
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| "Invalid model path")?;
        if unsafe {
            wf_speech_load(
                self.0.as_ptr(),
                path.as_ptr(),
                parakeet,
                gpu && cfg!(feature = "vulkan"),
            )
        } == 0
        {
            Ok(())
        } else {
            Err(self.error())
        }
    }
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        language: &str,
        vocabulary: &str,
    ) -> Result<String, String> {
        if samples.is_empty() || samples.iter().any(|s| !s.is_finite()) {
            return Err("Invalid audio samples".into());
        }
        let language = CString::new(language).map_err(|_| "Invalid language")?;
        let prompt = CString::new(vocabulary).map_err(|_| "Invalid vocabulary")?;
        let mut result = String::new();
        let mut start = 0;
        while start < samples.len() {
            let range = chunks::next_chunk(samples, start, chunks::MAX_CHUNK_SAMPLES);
            let mut padded = Vec::new();
            let chunk = if range.len() < chunks::MIN_CHUNK_SAMPLES {
                padded.extend_from_slice(&samples[range.clone()]);
                padded.resize(chunks::MIN_CHUNK_SAMPLES, 0.0);
                &padded
            } else {
                &samples[range.clone()]
            };
            let text = unsafe {
                wf_speech_transcribe(
                    self.0.as_ptr(),
                    chunk.as_ptr(),
                    chunk.len() as i32,
                    language.as_ptr(),
                    prompt.as_ptr(),
                )
            };
            if text.is_null() {
                return Err(self.error());
            }
            let text = unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .trim()
                .to_owned();
            if !text.is_empty() {
                if !result.is_empty() {
                    result.push(' ');
                }
                result.push_str(&text);
            }
            start = range.end;
        }
        Ok(result)
    }
}
impl Drop for SpeechEngine {
    fn drop(&mut self) {
        unsafe { wf_speech_destroy(self.0.as_ptr()) };
    }
}
