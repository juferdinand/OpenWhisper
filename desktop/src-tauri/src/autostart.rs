use crate::settings::private_write;
use std::{fs, path::PathBuf};
use tauri::Manager;

/// Per-user XDG autostart, shared by KDE, GNOME and other conforming desktops.
/// The installed AppImage path must be used, never its temporary extraction directory.
pub struct Autostart {
    entry: PathBuf,
    executable: PathBuf,
    appimage: bool,
}
impl Autostart {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let config = directories::BaseDirs::new()
            .ok_or("Home directory unavailable")?
            .config_dir()
            .to_path_buf();
        let image = app.env().appimage.map(PathBuf::from);
        let appimage = image.is_some();
        let executable = image
            .map(Ok)
            .unwrap_or_else(std::env::current_exe)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            entry: config.join("autostart/io.github.whisperfree.desktop"),
            executable,
            appimage,
        })
    }

    pub fn enabled(&self) -> Result<bool, String> {
        let content = match fs::read_to_string(&self.entry) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("Could not read launch-at-login settings: {e}")),
        };
        let mut in_entry = false;
        let mut hidden = false;
        let mut disabled = false;
        let mut executable = false;
        for line in content.lines().map(str::trim) {
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
            }
            if !in_entry {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                match key.trim() {
                    "Hidden" => hidden = value.trim() == "true",
                    "X-GNOME-Autostart-enabled" => disabled = value.trim() == "false",
                    "Exec" => executable = !value.trim().is_empty(),
                    _ => {}
                }
            }
        }
        Ok(executable && !hidden && !disabled)
    }

    pub fn set(&self, enabled: bool) -> Result<(), String> {
        let content = if enabled {
            if !self.executable.is_absolute() || !self.executable.is_file() {
                return Err(
                    "Launch at login requires an installed executable at a permanent location."
                        .into(),
                );
            }
            let executable = self
                .executable
                .to_str()
                .ok_or("Unsupported executable path")?;
            let argument = desktop_argument(executable)?;
            let prefix = if self.appimage {
                "env APPIMAGE_EXTRACT_AND_RUN=1 "
            } else {
                ""
            };
            format!("[Desktop Entry]\nType=Application\nName=OpenWhisper\nComment=Free, local dictation\nExec={prefix}{argument}\nIcon=io.github.whisperfree\nStartupWMClass=io.github.whisperfree\nTerminal=false\n")
        } else {
            // A user override also disables a potential system-wide entry with the same ID.
            "[Desktop Entry]\nType=Application\nName=OpenWhisper\nHidden=true\n".into()
        };
        fs::create_dir_all(
            self.entry
                .parent()
                .ok_or("Autostart directory unavailable")?,
        )
        .map_err(|e| format!("Could not create autostart directory: {e}"))?;
        private_write(&self.entry, content.as_bytes())
            .map_err(|e| format!("Could not save launch-at-login settings: {e}"))
    }
}

fn desktop_argument(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Unsupported executable path".into());
    }
    let mut quoted = String::from("\"");
    for c in value.chars() {
        if matches!(c, '\\' | '"' | '`' | '$') {
            quoted.push('\\');
        }
        if c == '%' {
            quoted.push('%');
        }
        quoted.push(c);
    }
    quoted.push('"');
    // Desktop Entry string escaping is applied before Exec argument parsing.
    Ok(quoted.replace('\\', "\\\\"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enable_disable_and_restart_use_the_installed_appimage() {
        let root =
            std::env::temp_dir().join(format!("openwhisper-autostart-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let image = root.join("Open Whisper.AppImage");
        fs::write(&image, "test").unwrap();
        let entry = root.join("autostart/io.github.whisperfree.desktop");
        let autostart = Autostart {
            entry: entry.clone(),
            executable: image.clone(),
            appimage: true,
        };
        assert!(!autostart.enabled().unwrap());
        autostart.set(true).unwrap();
        assert!(autostart.enabled().unwrap());
        let text = fs::read_to_string(&entry).unwrap();
        assert!(text.contains(&format!(
            "Exec=env APPIMAGE_EXTRACT_AND_RUN=1 \"{}\"",
            image.display()
        )));
        let reopened = Autostart {
            entry: entry.clone(),
            executable: image,
            appimage: true,
        };
        assert!(reopened.enabled().unwrap());
        fs::write(&entry, format!("{text}Hidden=true\n")).unwrap();
        assert!(!reopened.enabled().unwrap());
        reopened.set(true).unwrap();
        reopened.set(false).unwrap();
        assert!(!autostart.enabled().unwrap());
        assert!(!fs::read_to_string(entry).unwrap().contains("Exec="));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exec_paths_cannot_inject_arguments_or_desktop_entries() {
        assert_eq!(
            desktop_argument("/a b/Whisper%Free").unwrap(),
            "\"/a b/Whisper%%Free\""
        );
        assert_eq!(
            desktop_argument("/a\"$`\\").unwrap(),
            "\"/a\\\\\"\\\\$\\\\`\\\\\\\\\""
        );
        assert!(desktop_argument("/tmp/a\nExec=bad").is_err());
    }
}
