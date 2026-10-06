use super::session::wayland;
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    time::Duration,
};

pub fn clipboard(text: &str, owner: &mut Option<Child>) -> Result<(), String> {
    let mut command = if wayland() {
        let mut c = Command::new("wl-copy");
        c.args(["--foreground", "--type", "text/plain;charset=utf-8"]);
        c
    } else {
        let mut c = Command::new("xclip");
        c.args(["-selection", "clipboard", "-quiet"]);
        c
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "Clipboard unavailable ({e}). Install {} or copy from the transcript.",
                if wayland() { "wl-clipboard" } else { "xclip" }
            )
        })?;
    if let Err(error) = child.stdin.take().unwrap().write_all(text.as_bytes()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    std::thread::sleep(Duration::from_millis(80));
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
        return Err(format!("Clipboard process exited: {status}"));
    }
    if let Some(mut old) = owner.replace(child) {
        let _ = old.kill();
        let _ = old.wait();
    }
    Ok(())
}
