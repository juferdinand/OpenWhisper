use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::Manager;

const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const QUERY_TIMEOUT: Duration = Duration::from_millis(500);

async fn registered_host(connection: &zbus::Connection) -> bool {
    tokio::time::timeout(QUERY_TIMEOUT, async {
        // Resolve a running owner without activating a missing panel service.
        // Pin the subsequent property read to that unique owner: a panel that
        // vanishes between these calls must not be auto-started by polling.
        let bus = zbus::fdo::DBusProxy::new(connection).await?;
        let owner = bus.get_name_owner(WATCHER.try_into()?).await?;
        let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
            .destination(owner)?
            .path("/StatusNotifierWatcher")?
            .interface(WATCHER)?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await?;
        proxy
            .get_property::<bool>("IsStatusNotifierHostRegistered")
            .await
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or(false)
}

/// Creating an AppIndicator succeeds even when no desktop displays it. Only
/// hide the last window while an actual status notifier host is registered.
pub fn monitor(app: tauri::AppHandle) -> Arc<AtomicBool> {
    let available = Arc::new(AtomicBool::new(false));
    let result = available.clone();
    tauri::async_runtime::spawn(async move {
        let connection = tokio::time::timeout(Duration::from_secs(1), zbus::Connection::session())
            .await
            .ok()
            .and_then(Result::ok);
        loop {
            let Some(window) = app.get_webview_window("main") else {
                break;
            };
            let present = match connection.as_ref() {
                Some(connection) => registered_host(connection).await,
                None => false,
            };
            let previous = result.swap(present, Ordering::Relaxed);
            if previous && !present && !window.is_visible().unwrap_or(true) {
                // A disabled extension or a restarting panel must not strand
                // an application whose only window was hidden to that panel.
                let _ = window.show();
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    available
}
