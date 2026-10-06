use crate::Runtime;
use openwhisper_core::{catalog, Model};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

#[tauri::command]
pub fn cancel_download(runtime: tauri::State<'_, Arc<Runtime>>) {
    runtime.cancel_download.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn download_model(
    runtime: tauri::State<'_, Arc<Runtime>>,
    id: String,
) -> Result<(), String> {
    let model = catalog()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or("Unknown model")?;
    {
        let mut state = runtime.state.lock().unwrap();
        if state.updates.installing() {
            return Err("Wait for the update installation to finish".into());
        }
        if state.download.is_some() {
            return Err("A model download is already running".into());
        }
        if state.installed.contains(&id) {
            return Ok(());
        }
        runtime.cancel_download.store(false, Ordering::Relaxed);
        state.download = Some(id);
        state.progress = 0.0;
    }
    runtime.update(|s| s.message = "Downloading model from Hugging Face…".into());
    let result = fetch(runtime.inner(), &model).await;
    let installed = runtime.installed();
    runtime.update(|s| {
        s.download = None;
        s.installed = installed;
        s.message = match &result {
            Ok(_) => "Model downloaded and SHA-256 verified.".into(),
            Err(e) => e.clone(),
        };
    });
    result
}

async fn fetch(runtime: &Runtime, model: &Model) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::OpenOptionsExt;
    use tokio::io::AsyncWriteExt;
    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        model.repository, model.file
    );
    // The catalog determines the URL; LFS hashes detect incomplete or corrupted transfers.
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())?;
    let metadata = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .head(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let hash = metadata
        .headers()
        .get("x-linked-etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim_matches('"')
        .to_ascii_lowercase();
    let size = metadata
        .headers()
        .get("x-linked-size")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or("Model server did not provide a file size")?;
    if hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || !(1_000_000..=4_000_000_000).contains(&size)
    {
        return Err("Model server returned invalid integrity metadata".into());
    }
    let temporary =
        runtime
            .paths
            .models
            .join(format!("{}.{}.part", model.file, uuid::Uuid::new_v4()));
    let result = async {
        let output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut output = tokio::fs::File::from_std(output);
        let mut response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .bytes_stream();
        let mut digest = Sha256::new();
        let mut received = 0u64;
        let mut updated = Instant::now();
        while let Some(chunk) = response.next().await {
            if runtime.cancel_download.load(Ordering::Relaxed) {
                return Err("Download cancelled".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if received > size {
                return Err("Model download exceeded its declared size".into());
            }
            output.write_all(&chunk).await.map_err(|e| e.to_string())?;
            digest.update(&chunk);
            if updated.elapsed() > Duration::from_millis(200) {
                runtime.update(|s| s.progress = received as f64 / size as f64);
                updated = Instant::now();
            }
        }
        if received != size || format!("{:x}", digest.finalize()) != hash {
            return Err("Model integrity check failed; download discarded".into());
        }
        output.sync_all().await.map_err(|e| e.to_string())?;
        drop(output);
        tokio::fs::rename(&temporary, runtime.paths.models.join(&model.file))
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}
