use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    ptr::NonNull,
};

extern "C" {
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
        let count = i32::try_from(samples.len()).map_err(|_| "Recording is too long")?;
        let language = CString::new(language).map_err(|_| "Invalid language")?;
        let prompt = CString::new(vocabulary).map_err(|_| "Invalid vocabulary")?;
        let text = unsafe {
            wf_speech_transcribe(
                self.0.as_ptr(),
                samples.as_ptr(),
                count,
                language.as_ptr(),
                prompt.as_ptr(),
            )
        };
        if text.is_null() {
            Err(self.error())
        } else {
            Ok(unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned())
        }
    }
}
impl Drop for SpeechEngine {
    fn drop(&mut self) {
        unsafe { wf_speech_destroy(self.0.as_ptr()) };
    }
}
