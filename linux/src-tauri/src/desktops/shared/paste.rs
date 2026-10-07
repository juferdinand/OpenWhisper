//! Select the explicit session permission without changing clipboard delivery.
use crate::{
    desktops::{shared::portals, x11},
    Runtime,
};
use std::sync::Arc;

pub async fn enable(runtime: &Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.x11.permission_operation.lock().await;
    let native = {
        let state = runtime.state.lock().unwrap();
        state.native_paste && !state.paste_portal
    };
    if native {
        x11::enable_paste(runtime).await
    } else {
        x11::disable_paste(runtime);
        portals::enable_paste(runtime).await
    }
}
pub async fn disable(runtime: &Arc<Runtime>) {
    let _operation = runtime.x11.permission_operation.lock().await;
    x11::disable_paste(runtime);
    portals::disable_paste(runtime).await;
}
pub async fn paste(runtime: &Arc<Runtime>) -> Result<(), String> {
    let _operation = runtime.x11.permission_operation.lock().await;
    if x11::paste_enabled(runtime) {
        x11::paste(runtime).await
    } else {
        portals::paste(runtime).await
    }
}
