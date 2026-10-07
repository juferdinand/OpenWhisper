use openwhisper_core::{catalog, Snippet};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub ui_language: String,
    pub setup_completed: bool,
    pub auto_check_updates: bool,
    pub model: String,
    pub language: String,
    pub microphone: String,
    pub vocabulary: String,
    pub snippets: Vec<Snippet>,
    pub output: String,
    pub hold_to_record: bool,
    pub native_trigger: Option<crate::desktops::kde::Trigger>,
    pub x11_trigger: Option<crate::desktops::x11::Trigger>,
    pub gpu: bool,
    pub gpu_configured: bool,
    pub keep_history: bool,
    pub show_idle_overlay: bool,
    pub launch_at_login: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            ui_language: "en".into(),
            setup_completed: false,
            auto_check_updates: true,
            model: "base".into(),
            language: "auto".into(),
            microphone: String::new(),
            vocabulary: String::new(),
            snippets: vec![],
            output: "clipboard".into(),
            hold_to_record: false,
            native_trigger: None,
            x11_trigger: None,
            gpu: true,
            gpu_configured: true,
            keep_history: true,
            show_idle_overlay: false,
            launch_at_login: false,
        }
    }
}
impl Preferences {
    pub fn validate_recording_mode(&self, kde_active: bool) -> Result<(), String> {
        if kde_active
            && self.hold_to_record
            && self
                .native_trigger
                .as_ref()
                .is_some_and(|trigger| trigger.modifier_only())
        {
            return Err("Modifier-only triggers use toggle mode. Use a regular key or mouse button for push to talk.".into());
        }
        Ok(())
    }
    pub fn restore_kde_recording_mode(&mut self) {
        if self.validate_recording_mode(true).is_err() {
            self.hold_to_record = false;
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if let Some(trigger) = &self.x11_trigger {
            trigger.validate()?;
        }
        if let Some(trigger) = &self.native_trigger {
            trigger.validate()?;
        }
        if !["en", "de"].contains(&self.ui_language.as_str()) {
            return Err("Unknown interface language".into());
        }
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
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Cannot read settings: {e}"))?;
        // A malformed optional X11 binding must not reset ordinary saved preferences.
        if value
            .get("x11_trigger")
            .is_some_and(|trigger| !trigger.is_null())
        {
            let valid = serde_json::from_value::<crate::desktops::x11::Trigger>(
                value["x11_trigger"].clone(),
            )
            .is_ok_and(|trigger| trigger.validate().is_ok());
            if !valid {
                value["x11_trigger"] = serde_json::Value::Null;
            }
        }
        let mut prefs: Preferences = serde_json::from_value(value.clone())
            .map_err(|e| format!("Cannot read settings: {e}"))?;
        // Existing installations must not return to onboarding after an update.
        if value.get("setup_completed").is_none() {
            prefs.setup_completed = true;
        }
        // Public releases through 0.2.1 were CPU-only and exposed no GPU preference.
        if value.get("gpu_configured").is_none() {
            prefs.gpu = true;
            prefs.gpu_configured = true;
        }
        prefs.validate()?;
        if value.get("setup_completed").is_none() || value.get("gpu_configured").is_none() {
            self.save(&prefs)?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    fn isolated() -> Paths {
        let config =
            std::env::temp_dir().join(format!("openwhisper-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&config).unwrap();
        Paths {
            models: config.join("models"),
            config,
        }
    }
    #[test]
    fn cpu_only_installations_enable_gpu_but_a_new_cpu_choice_survives() {
        let paths = isolated();
        fs::write(
            paths.config.join("settings.json"),
            r#"{"gpu":false,"setup_completed":true}"#,
        )
        .unwrap();
        let mut prefs = paths.load().unwrap();
        assert!(prefs.gpu);
        assert!(prefs.gpu_configured);
        prefs.gpu = false;
        paths.save(&prefs).unwrap();
        assert!(!paths.load().unwrap().gpu);
        fs::remove_dir_all(paths.config).unwrap();
    }
    #[test]
    fn fresh_setup_and_language_survive_restarts() {
        let paths = isolated();
        let mut prefs = paths.load().unwrap();
        assert!(!prefs.setup_completed);
        prefs.ui_language = "de".into();
        paths.save(&prefs).unwrap();
        assert!(!paths.load().unwrap().setup_completed);
        prefs.setup_completed = true;
        paths.save(&prefs).unwrap();
        let reloaded = paths.load().unwrap();
        assert!(reloaded.setup_completed);
        assert_eq!(reloaded.ui_language, "de");
        assert_eq!(reloaded.language, "auto");
        fs::remove_dir_all(paths.config).unwrap();
    }
    #[test]
    fn recording_mode_follows_the_active_adapter_and_preserves_inactive_profiles() {
        let paths = isolated();
        let mut prefs = Preferences {
            native_trigger: Some(crate::desktops::kde::Trigger::Key { key: 0x0100_0021 }),
            x11_trigger: Some(crate::desktops::x11::Trigger {
                keycode: 74,
                keysym: 65477,
                modifiers: 0,
                group: 0,
            }),
            hold_to_record: true,
            ..Preferences::default()
        };
        // The current X11 adapter supports actual press/release even with a saved KDE modifier.
        assert!(prefs.validate_recording_mode(false).is_ok());
        assert!(prefs.validate_recording_mode(true).is_err());
        paths.save(&prefs).unwrap();
        prefs = paths.load().unwrap();
        assert!(prefs.hold_to_record);
        prefs.restore_kde_recording_mode();
        assert!(!prefs.hold_to_record);
        assert!(prefs.native_trigger.is_some());
        assert!(prefs.x11_trigger.is_some());
        assert!(prefs.validate_recording_mode(true).is_ok());
        // Returning to X11 can select hold mode without changing the retained KDE profile.
        prefs.hold_to_record = true;
        assert!(prefs.validate_recording_mode(false).is_ok());
        prefs.native_trigger = Some(crate::desktops::kde::Trigger::Key { key: 0x0100_0037 });
        assert!(prefs.validate_recording_mode(true).is_ok());
        fs::remove_dir_all(paths.config).unwrap();
    }
    #[test]
    fn malformed_optional_x11_binding_preserves_ordinary_preferences() {
        let paths = isolated();
        for trigger in [
            serde_json::json!("invalid"),
            serde_json::json!({"keycode": 0, "keysym": 65477, "modifiers": 0, "group": 0}),
            serde_json::json!({"keycode": 74, "keysym": 65477, "modifiers": 0, "group": 0, "extra": true}),
        ] {
            let mut value = serde_json::to_value(Preferences {
                model: "tiny".into(),
                language: "de".into(),
                ui_language: "de".into(),
                setup_completed: true,
                gpu: false,
                keep_history: false,
                vocabulary: "OpenWhisper".into(),
                ..Preferences::default()
            })
            .unwrap();
            value["x11_trigger"] = trigger;
            private_write(
                &paths.config.join("settings.json"),
                &serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            let prefs = paths.load().unwrap();
            assert!(prefs.x11_trigger.is_none());
            assert_eq!(prefs.model, "tiny");
            assert_eq!(prefs.language, "de");
            assert_eq!(prefs.ui_language, "de");
            assert_eq!(prefs.vocabulary, "OpenWhisper");
            assert!(prefs.setup_completed);
            assert!(!prefs.gpu);
            assert!(!prefs.keep_history);
        }
        let invalid = Preferences {
            x11_trigger: Some(crate::desktops::x11::Trigger {
                keycode: 0,
                keysym: 65477,
                modifiers: 0,
                group: 0,
            }),
            ..Preferences::default()
        };
        assert!(paths.save(&invalid).is_err());
        fs::remove_dir_all(paths.config).unwrap();
    }
    #[test]
    fn legacy_installations_migrate_without_reopening_setup_or_losing_preferences() {
        let paths = isolated();
        private_write(
            &paths.config.join("settings.json"),
            br#"{"model":"tiny","language":"de","vocabulary":"WhisperFree"}"#,
        )
        .unwrap();
        let prefs = paths.load().unwrap();
        assert!(prefs.setup_completed);
        assert_eq!(prefs.model, "tiny");
        assert_eq!(prefs.language, "de");
        assert_eq!(prefs.vocabulary, "WhisperFree");
        assert_eq!(prefs.ui_language, "en");
        assert!(paths.load().unwrap().setup_completed);
        fs::remove_dir_all(paths.config).unwrap();
    }
}
