use std::{
    ffi::OsString,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::PathBuf,
    process::Command,
    sync::Mutex,
};

/// Preserve the process lifetime when a desktop launcher supervises the app with systemd.
/// Spawning a child and exiting lets the supervisor kill the replacement with the old service.
pub struct Relaunch {
    executable: Result<PathBuf, String>,
    arguments: Vec<OsString>,
    pending: Mutex<Option<Command>>,
}

impl Relaunch {
    pub fn new(executable: Result<PathBuf, String>, arguments: Vec<OsString>) -> Self {
        Self {
            executable,
            arguments,
            pending: Mutex::new(None),
        }
    }

    /// Validate the installed path while the UI can still report a failure.
    pub fn request(&self) -> Result<(), String> {
        let executable = self.executable.as_ref().map_err(Clone::clone)?;
        let metadata = std::fs::metadata(executable)
            .map_err(|e| format!("Could not restart the installed app: {e}"))?;
        if !executable.is_absolute()
            || !metadata.is_file()
            || metadata.permissions().mode() & 0o111 == 0
        {
            return Err("The installed app is not an executable file. Restart it manually.".into());
        }
        let mut command = Command::new(executable);
        command.args(&self.arguments);
        *self.pending.lock().unwrap() = Some(command);
        Ok(())
    }

    /// Call only after the native event loop has closed windows and released its application ID.
    /// exec keeps the PID (and the AppImage runtime's waiting parent) alive across the update.
    pub fn finish(&self, exit_code: i32) -> i32 {
        if let Some(mut command) = self.pending.lock().unwrap().take() {
            let error = command.exec();
            eprintln!("The update is installed, but OpenWhisper could not restart: {error}. Open the app manually.");
            return 1;
        }
        exit_code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaunch_preserves_pid_and_arguments() {
        let path =
            std::env::temp_dir().join(format!("openwhisper-relaunch-{}", uuid::Uuid::new_v4()));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "relaunch::tests::exec_fixture", "--nocapture"])
            .env("OPENWHISPER_RELAUNCH_TEST_OUTPUT", &path)
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{pid}\nargument with spaces; $literal\n")
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn exec_fixture() {
        let Some(output) = std::env::var_os("OPENWHISPER_RELAUNCH_TEST_OUTPUT") else {
            return;
        };
        let relaunch = Relaunch::new(
            Ok(PathBuf::from("/bin/sh")),
            vec![
                "-c".into(),
                "printf '%s\\n' \"$$\" \"$1\" > \"$2\"".into(),
                "relaunch-test".into(),
                "argument with spaces; $literal".into(),
                output,
            ],
        );
        relaunch.request().unwrap();
        panic!("exec returned: {}", relaunch.finish(0));
    }

    #[test]
    fn invalid_relaunch_does_not_request_exit() {
        let relaunch = Relaunch::new(Err("No installed executable".into()), vec![]);
        assert!(relaunch.request().is_err());
        assert_eq!(relaunch.finish(7), 7);
        let relaunch = Relaunch::new(Ok(std::env::temp_dir()), vec![]);
        assert!(relaunch.request().is_err());
        assert_eq!(relaunch.finish(0), 0);
    }
}
