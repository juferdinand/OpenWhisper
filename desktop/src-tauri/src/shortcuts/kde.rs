use super::Trigger;
use crate::settings::private_write;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use zbus::{Connection, Proxy};

pub const COMPONENT_PREFIX: &str = "io.github.whisperfree.trigger.";
pub const ACTION: &str = "_k_session:dictate";
const ABSENT: &str = "__WHISPERFREE_ABSENT_0e71bf4c__";

pub async fn accelerator(connection: &Connection) -> Result<Proxy<'_>, String> {
    Proxy::new(
        connection,
        "org.kde.kglobalaccel",
        "/kglobalaccel",
        "org.kde.KGlobalAccel",
    )
    .await
    .map_err(|e| e.to_string())
}

pub async fn capabilities() -> (bool, bool, bool) {
    let result = async {
        let connection = Connection::session().await.ok()?;
        let bus = zbus::fdo::DBusProxy::new(&connection).await.ok()?;
        for service in ["org.kde.KWin", "org.kde.kglobalaccel"] {
            if !bus.name_has_owner(service.try_into().ok()?).await.ok()? {
                return None;
            }
        }
        let kwin = Proxy::new(&connection, "org.kde.KWin", "/KWin", "org.kde.KWin")
            .await
            .ok()?;
        let info: String = kwin.call("supportInformation", &()).await.ok()?;
        let version = info
            .lines()
            .find_map(|line| line.strip_prefix("KWin version: "))?;
        let numbers: Vec<u32> = version
            .split('.')
            .take(2)
            .map(|s| s.parse().unwrap_or(0))
            .collect();
        if numbers.first().copied().unwrap_or(0) < 6 {
            return None;
        }
        let plugins = Proxy::new(
            &connection,
            "org.kde.KWin",
            "/Plugins",
            "org.kde.KWin.Plugins",
        )
        .await
        .ok()?;
        let loaded: Vec<String> = plugins
            .get_property("LoadedPlugins")
            .await
            .unwrap_or_default();
        let mouse = crate::integration::wayland()
            && loaded.iter().any(|p| p == "buttonsrebind")
            && crate::integration::available("kreadconfig6")
            && crate::integration::available("kwriteconfig6");
        Some((
            true,
            mouse,
            mouse && (numbers[0] > 6 || numbers.get(1).copied().unwrap_or(0) >= 3),
        ))
    };
    tokio::time::timeout(std::time::Duration::from_secs(4), result)
        .await
        .ok()
        .flatten()
        .unwrap_or((false, false, false))
}

fn config_command(program: &str, key: &str) -> Command {
    let mut command = Command::new(program);
    command.args([
        "--file",
        "kcminputrc",
        "--group",
        "ButtonRebinds",
        "--group",
        "Mouse",
        "--key",
        key,
    ]);
    // These are system Qt utilities, not binaries shipped in the GTK AppImage.
    command
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD");
    command
}
fn read_mapping(key: &str) -> Result<Option<String>, String> {
    let output = config_command("kreadconfig6", key)
        .args(["--default", ABSENT])
        .output()
        .map_err(|e| format!("Could not read KDE's mouse settings: {e}"))?;
    if !output.status.success() {
        return Err("Could not read KDE's mouse settings.".into());
    }
    let value = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let value = value.trim_end_matches(['\r', '\n']).to_string();
    if value == ABSENT {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}
fn write_mapping(key: &str, value: Option<&str>) -> Result<(), String> {
    let mut command = config_command("kwriteconfig6", key);
    command.arg("--notify");
    match value {
        Some(value) => {
            command.arg(value);
        }
        None => {
            command.arg("--delete");
        }
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not update KDE's mouse settings: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Could not update KDE's mouse settings.".into())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    pub component: String,
    pid: u32,
    started: String,
    trigger: Trigger,
    original: Option<String>,
    assigned: Option<String>,
}
fn start_time(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)
        .map(str::to_owned)
}
fn lease_path(config: &Path) -> PathBuf {
    config.join("native-trigger-lease.json")
}
impl Lease {
    pub fn new(trigger: Trigger, assigned: Option<String>, config: &Path) -> Result<Self, String> {
        trigger.validate()?;
        let original = match trigger.mouse_config_key() {
            Some(key) => {
                let existing = read_mapping(&key)?;
                if existing.as_ref().is_some_and(|value| !value.is_empty()) {
                    return Err("This mouse button is already remapped in KDE. Choose another button or change its mapping in System Settings first.".into());
                }
                existing
            }
            None => None,
        };
        let lease = Self {
            component: format!("{COMPONENT_PREFIX}{}", uuid::Uuid::new_v4().simple()),
            pid: std::process::id(),
            started: start_time(std::process::id())
                .ok_or("Could not identify the trigger helper")?,
            trigger,
            original,
            assigned,
        };
        private_write(
            &lease_path(config),
            &serde_json::to_vec(&lease).map_err(|e| e.to_string())?,
        )?;
        Ok(lease)
    }
    pub fn apply_mouse(&self) -> Result<(), String> {
        if let Some(key) = self.trigger.mouse_config_key() {
            if read_mapping(&key)? != self.original {
                return Err(
                    "The mouse mapping changed while the trigger was being configured. Try again."
                        .into(),
                );
            }
            write_mapping(&key, self.assigned.as_deref())?;
        }
        Ok(())
    }
    pub async fn release(&self, proxy: &Proxy<'_>, config: &Path) -> Result<(), String> {
        let keyboard: Result<bool, _> = proxy.call("unregister", &(&self.component, ACTION)).await;
        if let Some(key) = self.trigger.mouse_config_key() {
            // A later user edit belongs to the user. Never restore over it.
            if read_mapping(&key)? == self.assigned {
                write_mapping(&key, self.original.as_deref())?;
            }
        }
        keyboard.map_err(|e| format!("Could not release the keyboard trigger: {e}"))?;
        match std::fs::remove_file(lease_path(config)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub async fn recover(proxy: &Proxy<'_>, config: &Path) -> Result<(), String> {
    let data = match std::fs::read(lease_path(config)) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if data.len() > 4096 {
        return Err("The trigger recovery file is invalid.".into());
    }
    let lease: Lease =
        serde_json::from_slice(&data).map_err(|_| "The trigger recovery file is invalid.")?;
    lease.trigger.validate()?;
    let id = lease
        .component
        .strip_prefix(COMPONENT_PREFIX)
        .ok_or("The trigger recovery identity is invalid.")?;
    uuid::Uuid::parse_str(id).map_err(|_| "The trigger recovery identity is invalid.")?;
    if lease.original.as_ref().is_some_and(|v| !v.is_empty())
        || lease.assigned.as_ref().is_some_and(|v| {
            !mouse_chords()
                .iter()
                .any(|(_, chord)| v == &format!("Key,{chord}"))
        })
    {
        return Err("The trigger recovery mapping is invalid.".into());
    }
    if start_time(lease.pid).as_deref() == Some(&lease.started) {
        return Err(
            "Another trigger helper is still running. Try again after it has stopped.".into(),
        );
    }
    lease.release(proxy, config).await
}

pub fn mouse_chords() -> Vec<(i32, String)> {
    (9..=12)
        .rev()
        .map(|n| {
            (
                0x16000000 | (0x01000030 + n - 1),
                format!("Ctrl+Shift+Meta+F{n}"),
            )
        })
        .collect()
}
