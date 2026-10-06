use gtk::{glib::translate::ToGlibPtr, prelude::*};
use libloading::Library;
use std::sync::OnceLock;
use tauri::{Manager, WebviewBuilder, WebviewUrl, WindowBuilder};

// Keep the optional system library loaded while GTK owns its Wayland callbacks.
static LAYER_SHELL: OnceLock<Option<Library>> = OnceLock::new();

fn layer_shell() -> Option<&'static Library> {
    LAYER_SHELL
        .get_or_init(|| unsafe { Library::new("libgtk-layer-shell.so.0").ok() })
        .as_ref()
}

pub fn create(app: &tauri::App) -> Result<bool, Box<dyn std::error::Error>> {
    let layer = if crate::integration::wayland() {
        let Some(library) = layer_shell() else {
            return Ok(false);
        };
        // Signatures and enum values follow gtk-layer-shell's public C header.
        let supported = unsafe {
            library.get::<unsafe extern "C" fn() -> i32>(b"gtk_layer_is_supported\0")?() != 0
        };
        if !supported {
            return Ok(false);
        }
        Some(library)
    } else {
        None
    };
    // Initialize layer-shell before adding the webview, which realizes its GTK window.
    let window = WindowBuilder::new(app, "overlay")
        .title("WhisperFree Recording")
        .inner_size(340., 64.)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .always_on_top(true)
        .visible(false)
        .build()?;
    let native = window.gtk_window()?;
    native.set_accept_focus(false);
    native.set_focus_on_map(false);
    if let Some(library) = layer {
        let pointer = native.upcast_ref::<gtk::Window>().to_glib_none().0;
        unsafe {
            type Set = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, i32);
            type Edge = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, i32, i32);
            library.get::<unsafe extern "C" fn(*mut gtk::ffi::GtkWindow)>(
                b"gtk_layer_init_for_window\0",
            )?(pointer);
            library.get::<Set>(b"gtk_layer_set_layer\0")?(pointer, 3);
            library.get::<Set>(b"gtk_layer_set_keyboard_mode\0")?(pointer, 0);
            library.get::<Edge>(b"gtk_layer_set_anchor\0")?(pointer, 3, 1);
            library.get::<Edge>(b"gtk_layer_set_margin\0")?(pointer, 3, 28);
        }
    } else if let Some(monitor) = window.primary_monitor()? {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let origin = monitor.position().to_logical::<f64>(monitor.scale_factor());
        window.set_position(tauri::LogicalPosition::new(
            origin.x + (size.width - 340.) / 2.,
            origin.y + size.height - 112.,
        ))?;
    }
    window.add_child(
        WebviewBuilder::new("overlay", WebviewUrl::App("index.html?overlay".into()))
            .transparent(true),
        tauri::LogicalPosition::new(0., 0.),
        tauri::LogicalSize::new(340., 64.),
    )?;
    Ok(true)
}

pub fn update(app: &tauri::AppHandle, status: &str, show_idle: bool) {
    if let Some(window) = app.get_window("overlay") {
        if matches!(status, "recording" | "transcribing" | "error") || show_idle {
            if !window.is_visible().unwrap_or(false) {
                let _ = window.show();
            }
        } else {
            let _ = window.hide();
        }
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!(
            "WhisperFree — {}",
            match status {
                "recording" => "Recording · click to stop",
                "transcribing" => "Transcribing locally",
                "error" => "Open the app to check an error",
                _ => "Ready to dictate",
            }
        )));
    }
}
