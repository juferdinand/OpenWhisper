use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use whisperfree_core::{catalog, Snippet};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub model: String,
    pub language: String,
    pub microphone: String,
    pub vocabulary: String,
    pub snippets: Vec<Snippet>,
    pub output: String,
    pub hold_to_record: bool,
    pub gpu: bool,
    pub keep_history: bool,
    pub show_idle_overlay: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            model: "base".into(),
            language: "auto".into(),
            microphone: String::new(),
            vocabulary: String::new(),
            snippets: vec![],
            output: "clipboard".into(),
            hold_to_record: false,
            gpu: false,
            keep_history: true,
            show_idle_overlay: false,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        if !catalog().iter().any(|m| m.id == self.model) {
            return Err("Unknown model".into());
        }
        if self.language != "auto"
            && !(self.language.len() == 2 && self.language.bytes().all(|b| b.is_ascii_lowercase()))
        {
            return Err("Language must be 'auto' or a two-letter language code".into());
        }
        if !["clipboard", "paste"].contains(&self.output.as_str()) {
            return Err("Unknown output mode".into());
        }
        if self.vocabulary.len() > 8192 || self.microphone.len() > 1024 || self.snippets.len() > 100
        {
            return Err("Settings exceed the supported size".into());
        }
        if self.snippets.iter().any(|s| {
            s.trigger.trim().is_empty() || s.trigger.len() > 128 || s.expansion.len() > 8192
        }) {
            return Err(
                "Each snippet needs a trigger (up to 128 bytes) and expansion (up to 8 KB)".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Paths {
    pub config: PathBuf,
    pub models: PathBuf,
}
impl Paths {
    pub fn new() -> Result<Self, String> {
        let dirs = directories::ProjectDirs::from("io.github", "", "whisperfree")
            .ok_or("Home directory unavailable")?;
        let config = dirs.config_dir().to_path_buf();
        let models = dirs.data_dir().join("models");
        for dir in [&config, &models] {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { config, models })
    }
    pub fn load(&self) -> Result<Preferences, String> {
        let path = self.config.join("settings.json");
        if !path.exists() {
            return Ok(Preferences::default());
        }
        let prefs: Preferences =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Cannot read settings: {e}"))?;
        prefs.validate()?;
        Ok(prefs)
    }
    pub fn save(&self, prefs: &Preferences) -> Result<(), String> {
        prefs.validate()?;
        private_write(
            &self.config.join("settings.json"),
            &serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?,
        )
    }
    pub fn load_history(&self) -> Result<Vec<String>, String> {
        let path = self.config.join("history.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        let mut history: Vec<String> =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        history.truncate(20);
        Ok(history)
    }
    pub fn save_history(&self, history: &[String]) -> Result<(), String> {
        private_write(
            &self.config.join("history.json"),
            &serde_json::to_vec(history).map_err(|e| e.to_string())?,
        )
    }
}

pub fn private_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e: std::io::Error| e.to_string())
}
