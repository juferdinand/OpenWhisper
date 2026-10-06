use crate::{settings::private_write, Runtime};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    utils::{config::BundleType, platform::bundle_type},
    Manager,
};
use tauri_plugin_updater::{Update, UpdaterExt};
use whisperfree_core::updates::{self as policy, Package};

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub configured: bool,
    pub status: String,
    pub version: Option<String>,
    pub progress: f64,
    pub error: Option<String>,
    pub package: String,
}
impl Snapshot {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let package = package(app);
        Self {
            configured: cfg!(feature = "release-updater") && package.is_some(),
            status: "idle".into(),
            version: None,
            progress: 0.0,
            error: None,
            package: match package {
                Some(Package::Debian) => "deb",
                Some(Package::AppImage) => "appimage",
                None => "development",
            }
            .into(),
        }
    }
    pub fn installing(&self) -> bool {
        matches!(self.status.as_str(), "downloading" | "installing")
    }
}

#[derive(Default)]
pub struct Service {
    pending: Mutex<Option<Update>>,
    operation: tokio::sync::Mutex<()>,
}

fn package(app: &tauri::AppHandle) -> Option<Package> {
    if app.env().appimage.is_some() {
        Some(Package::AppImage)
    } else if bundle_type() == Some(BundleType::Deb) {
        Some(Package::Debian)
    } else {
        None
    }
}

pub fn start(runtime: Arc<Runtime>) {
    if crate::smoke::enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            let enabled = {
                let s = runtime.state.lock().unwrap();
                s.updates.configured && s.preferences.auto_check_updates
            };
            if enabled {
                let _ = check(runtime.clone()).await;
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

#[tauri::command]
pub async fn check_updates(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    check(runtime.inner().clone()).await
}

async fn check(runtime: Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime
        .updater
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    if !runtime.state.lock().unwrap().updates.configured {
        return Err("Updates are not configured in this build.".into());
    }
    runtime.update(|s| {
        s.updates.status = "checking".into();
        s.updates.error = None;
    });
    let result = async {
        let kind = package(&runtime.app).ok_or("Unsupported installation type")?;
        let update = runtime
            .app
            .updater_builder()
            .target(kind.target())
            .endpoints(vec![policy::ENDPOINT.parse().unwrap()])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        if let Some(ref update) = update {
            policy::validate(
                &update.version,
                env!("CARGO_PKG_VERSION"),
                update.download_url.as_str(),
                kind,
            )?;
        }
        runtime.update(|s| {
            s.updates.status = if update.is_some() {
                "available"
            } else {
                "current"
            }
            .into();
            s.updates.version = update.as_ref().map(|u| u.version.clone());
        });
        *runtime.updater.pending.lock().unwrap() = update;
        Ok::<_, String>(())
    }
    .await;
    if let Err(ref error) = result {
        *runtime.updater.pending.lock().unwrap() = None;
        failed(&runtime, error.clone());
    }
    result
}

#[tauri::command]
pub async fn install_update(runtime: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    install(runtime.inner().clone()).await
}

async fn install(runtime: Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime
        .updater
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    let mut update = runtime
        .updater
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("Check for an update first")?;
    {
        let mut state = runtime.state.lock().unwrap();
        if matches!(state.status.as_str(), "recording" | "transcribing") || state.download.is_some()
        {
            return Err("Finish dictation and model downloads before installing an update".into());
        }
        state.updates.status = "downloading".into();
        state.updates.progress = 0.0;
        state.updates.error = None;
    }
    runtime.update(|_| {});
    let result = async {
        let kind = package(&runtime.app).ok_or("Unsupported installation type")?;
        policy::validate(
            &update.version,
            env!("CARGO_PKG_VERSION"),
            update.download_url.as_str(),
            kind,
        )?;
        update.timeout = Some(Duration::from_secs(15 * 60));
        let mut received = 0u64;
        // The plugin checks the embedded public key AND the signed app-version before returning bytes.
        let bytes = update
            .download(
                |length, total| {
                    received += length as u64;
                    runtime.update(|s| {
                        s.updates.progress = total
                            .filter(|n| *n > 0)
                            .map(|n| (received as f64 / n as f64).min(1.0))
                            .unwrap_or(0.0)
                    });
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        runtime.update(|s| s.updates.status = "installing".into());
        let directory = runtime.paths.config.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if kind == Package::Debian {
                install_debian(&bytes, &directory, &update.version)
            } else {
                update.install(bytes).map_err(|e| e.to_string())
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok::<_, String>(())
    }
    .await;
    match result {
        Ok(()) => runtime.app.restart(),
        Err(error) => {
            failed(&runtime, error.clone());
            Err(error)
        }
    }
}

fn failed(runtime: &Runtime, error: String) {
    runtime.update(|s| {
        s.updates.status = "error".into();
        s.updates.error = Some(error);
    });
}

fn install_debian(bytes: &[u8], directory: &std::path::Path, version: &str) -> Result<(), String> {
    // Let the system authentication agent handle elevation. Never collect a password in the app
    // or retry a cancelled permission prompt through another authentication mechanism.
    let path = directory.join(format!("update-{}.deb", uuid::Uuid::new_v4()));
    private_write(&path, bytes)?;
    let result = (|| {
        for (field, expected) in [
            ("Package", "io-github-whisperfree"),
            ("Version", version),
            ("Architecture", "amd64"),
        ] {
            let output = std::process::Command::new("/usr/bin/dpkg-deb")
                .args(["--field"])
                .arg(&path)
                .arg(field)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success()
                || String::from_utf8_lossy(&output.stdout).trim() != expected
            {
                return Err("The update package identity or version is invalid".into());
            }
        }
        let status = std::process::Command::new("/usr/bin/pkexec")
            .args(["/usr/bin/dpkg", "--install"])
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("The package installation was cancelled or failed".into());
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(path);
    result
}
