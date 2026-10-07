use super::session::wayland;
use rustix::{
    event::{poll, PollFd, PollFlags, Timespec},
    fs::{fcntl_getfl, fcntl_setfl, OFlags},
    process::{kill_process_group, waitid, Pid, Signal, WaitId, WaitIdOptions},
};
use std::{
    io::{ErrorKind, Write},
    os::unix::process::CommandExt,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
pub const FAILED: &str =
    "Clipboard delivery could not be confirmed. Copy from the transcript or try again";
const TIMED_OUT: &str = "Clipboard delivery timed out. Copy from the transcript or try again";

pub struct ClipboardOwner {
    child: Option<Child>,
    wayland: bool,
}

impl ClipboardOwner {
    pub fn finish(self) {
        // Preserve explicit Quit/update cleanup for both clipboard helpers.
        self.stop();
    }
    fn stop(mut self) {
        if let Some(child) = self.child.take() {
            terminate(child, self.wayland);
        }
    }
}

impl Drop for ClipboardOwner {
    fn drop(&mut self) {
        if self.wayland {
            // Readiness already observed this parent's exit with WNOWAIT.
            // Ordinary object drop only reaps the completed parent. Explicit
            // application exit uses finish() to stop its private owner group.
            if let Some(mut child) = self.child.take() {
                let _ = child.wait();
            }
        }
        // A persistent X11 helper cannot be waited for in ordinary object drop.
    }
}

#[derive(Default)]
pub struct Clipboard {
    owner: Mutex<Option<ClipboardOwner>>,
    shutting_down: AtomicBool,
}

impl Clipboard {
    pub fn copy(&self, text: &str) -> Result<(), String> {
        self.deliver(|owner| clipboard(text, owner))
    }

    fn deliver(
        &self,
        copy: impl FnOnce(&mut Option<ClipboardOwner>) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut owner = self.owner.lock().unwrap();
        // Recheck inside the lock: queued IPC/worker requests must not create
        // another helper after Exit has cleaned the previous owner.
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(FAILED.into());
        }
        copy(&mut owner)
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        if let Some(owner) = self.owner.lock().unwrap().take() {
            owner.finish();
        }
    }
}

fn exited(child: &Child) -> Result<Option<bool>, rustix::io::Errno> {
    waitid(
        WaitId::Pid(Pid::from_child(child)),
        WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
    )
    .map(|status| status.map(|status| status.exit_status() == Some(0)))
}

fn terminate(mut child: Child, group: bool) {
    let deadline = Instant::now() + Duration::from_millis(200);
    if group {
        // No try_wait/wait reaps this parent's PID before its private group is
        // signalled. Lost wait ownership (including ECHILD) forbids numeric kill.
        loop {
            match exited(&child) {
                Ok(_) => break,
                Err(rustix::io::Errno::INTR) if Instant::now() < deadline => continue,
                Err(_) => return,
            }
        }
        let _ = kill_process_group(Pid::from_child(&child), Signal::KILL);
    } else {
        let _ = child.kill();
    }
    loop {
        match exited(&child) {
            Ok(Some(_)) => {
                let _ = child.wait();
                return;
            }
            Err(rustix::io::Errno::INTR) => {}
            Err(_) => return,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            // An uninterruptible child must not block the UI/worker after the
            // deadline. Keep its ownership in a reaper until the kill completes.
            let _ = std::thread::Builder::new()
                .name("clipboard-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn feed(mut input: ChildStdin, text: &[u8], deadline: Instant) -> Result<(), String> {
    let flags = fcntl_getfl(&input).map_err(|_| FAILED)?;
    fcntl_setfl(&input, flags | OFlags::NONBLOCK).map_err(|_| FAILED)?;
    let mut written = 0;
    while written < text.len() {
        if Instant::now() >= deadline {
            return Err(TIMED_OUT.into());
        }
        match input.write(&text[written..text.len().min(written + 16 * 1024)]) {
            Ok(0) => return Err(FAILED.into()),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                let mut fds = [PollFd::new(&input, PollFlags::OUT)];
                let remaining = deadline.saturating_duration_since(Instant::now());
                let timeout =
                    Timespec::try_from(POLL_INTERVAL.min(remaining)).map_err(|_| FAILED)?;
                match poll(&mut fds, Some(&timeout)) {
                    Ok(_)
                        if fds[0]
                            .revents()
                            .intersects(PollFlags::ERR | PollFlags::HUP | PollFlags::NVAL) =>
                    {
                        return Err(FAILED.into())
                    }
                    Ok(_) | Err(rustix::io::Errno::INTR) => {}
                    Err(_) => return Err(FAILED.into()),
                }
            }
            Err(_) => return Err(FAILED.into()),
        }
    }
    // Closing stdin lets wl-copy finish its private input file before attempting
    // ownership. Transcript bytes never enter argv, stdout, or diagnostic logs.
    Ok(())
}

fn copy_with(
    mut command: Command,
    text: &str,
    owner: &mut Option<ClipboardOwner>,
    is_wayland: bool,
    timeout: Duration,
) -> Result<(), String> {
    if is_wayland {
        command.process_group(0);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Clipboard unavailable. Install wl-clipboard (Wayland) or xclip (X11)")?;
    let deadline = Instant::now() + timeout;
    let result = (|| {
        feed(child.stdin.take().ok_or(FAILED)?, text.as_bytes(), deadline)?;
        if is_wayland {
            loop {
                if Instant::now() >= deadline {
                    return Err(TIMED_OUT.into());
                }
                match exited(&child) {
                    Ok(Some(true)) => return Ok(()),
                    Ok(Some(false)) => return Err(FAILED.into()),
                    Ok(None) | Err(rustix::io::Errno::INTR) => {}
                    Err(_) => return Err(FAILED.into()),
                }
                std::thread::sleep(
                    POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        } else {
            // Keep xclip's established foreground/alive readiness policy.
            std::thread::sleep(Duration::from_millis(80));
            if child.try_wait().map_err(|_| FAILED)?.is_some() {
                return Err(FAILED.into());
            }
            Ok(())
        }
    })();
    if let Err(error) = result {
        terminate(child, is_wayland);
        return Err(error);
    }
    // wl-copy 2.2.1 forks only after set_selection + display roundtrip, without
    // setsid/setpgid. Its unreaped parent pins the background owner's PGID until
    // replacement. A still-running foreground process does not prove readiness.
    let replacement = ClipboardOwner {
        child: Some(child),
        wayland: is_wayland,
    };
    if let Some(old) = owner.replace(replacement) {
        old.stop();
    }
    Ok(())
}

pub fn clipboard(text: &str, owner: &mut Option<ClipboardOwner>) -> Result<(), String> {
    let is_wayland = wayland();
    let mut command = if is_wayland {
        Command::new("wl-copy")
    } else {
        Command::new("xclip")
    };
    if is_wayland {
        command.args(["--type", "text/plain;charset=utf-8"]);
    } else {
        command.args(["-selection", "clipboard", "-quiet"]);
    }
    copy_with(command, text, owner, is_wayland, TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "ow-clipboard-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::write(
                path.join("helper.py"),
                r#"
import hashlib, json, os, signal, sys, time
root, mode = sys.argv[1:]
record = {'parent': os.getpid(), 'group': os.getpgrp(), 'argv_count': len(sys.argv)}
def save():
    with open(root + '/result.json', 'w') as file:
        json.dump(record, file)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
save()
if mode == 'no-read':
    time.sleep(30)
    sys.exit(1)
data = sys.stdin.buffer.read()
record.update(size=len(data), digest=hashlib.sha256(data).hexdigest())
if mode == 'nonzero':
    save()
    sys.stderr.write(data.decode('utf-8'))
    sys.exit(7)
if mode == 'x11':
    save()
    time.sleep(30)
    sys.exit(0)
child = os.fork()
if child == 0:
    if mode == 'persist':
        time.sleep(1.0)
        os._exit(0)
    while True:
        signal.pause()
record['descendant'] = child
save()
if mode == 'read-hang':
    while True:
        signal.pause()
os._exit(0)
"#,
            )
            .unwrap();
            Self(path)
        }
        fn command(&self, mode: &str) -> Command {
            let mut command = Command::new("python3");
            command.arg(self.0.join("helper.py")).arg(&self.0).arg(mode);
            command
        }
        fn result(&self) -> serde_json::Value {
            serde_json::from_slice(&fs::read(self.0.join("result.json")).unwrap()).unwrap()
        }
        fn copy(
            &self,
            mode: &str,
            text: &str,
            owner: &mut Option<ClipboardOwner>,
            timeout: Duration,
        ) -> Result<(), String> {
            copy_with(self.command(mode), text, owner, true, timeout)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn state(pid: u64) -> Option<char> {
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|value| {
                value
                    .rsplit_once(") ")
                    .and_then(|(_, tail)| tail.chars().next())
            })
    }
    fn stopped(pid: u64) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !matches!(state(pid), None | Some('Z')) {
            assert!(
                Instant::now() < deadline,
                "Owned fixture process is still running"
            );
            std::thread::sleep(POLL_INTERVAL);
        }
    }
    fn owner_pid(owner: &Option<ClipboardOwner>) -> u64 {
        u64::from(owner.as_ref().unwrap().child.as_ref().unwrap().id())
    }

    #[test]
    fn no_reader_and_readiness_hang_are_bounded_and_ignore_term_is_killed() {
        for mode in ["no-read", "read-hang"] {
            let fixture = Fixture::new();
            let started = Instant::now();
            let mut owner = None;
            assert_eq!(
                fixture.copy(
                    mode,
                    &"x".repeat(1024 * 1024),
                    &mut owner,
                    Duration::from_millis(150)
                ),
                Err(TIMED_OUT.into())
            );
            assert!(started.elapsed() < Duration::from_secs(1));
            assert!(owner.is_none());
            let result = fixture.result();
            let parent = result["parent"].as_u64().unwrap();
            assert_eq!(result["group"].as_u64(), Some(parent));
            assert!(state(parent).is_none(), "The failed parent was not reaped");
            if let Some(child) = result["descendant"].as_u64() {
                stopped(child);
            }
        }
    }

    #[test]
    fn nonzero_exit_does_not_become_a_clipboard_owner() {
        let fixture = Fixture::new();
        let mut owner = None;
        assert_eq!(
            fixture.copy("nonzero", "private fixture", &mut owner, TIMEOUT),
            Err(FAILED.into())
        );
        assert!(owner.is_none());
        assert!(state(fixture.result()["parent"].as_u64().unwrap()).is_none());
    }

    #[test]
    fn large_multibyte_input_is_exact_and_successful_parent_remains_pinned() {
        use sha2::{Digest, Sha256};
        let fixture = Fixture::new();
        let text = "Grüße世界🙂\n".repeat(100_000);
        let mut owner = None;
        fixture.copy("ready", &text, &mut owner, TIMEOUT).unwrap();
        let result = fixture.result();
        assert_eq!(result["size"].as_u64(), Some(text.len() as u64));
        assert_eq!(
            result["digest"].as_str(),
            Some(
                Sha256::digest(text.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
                    .as_str()
            )
        );
        assert_eq!(result["argv_count"].as_u64(), Some(3));
        let child = owner.as_ref().unwrap().child.as_ref().unwrap();
        assert_eq!(exited(child).unwrap(), Some(true));
        assert_eq!(exited(child).unwrap(), Some(true));
        assert_eq!(state(owner_pid(&owner)), Some('Z'));
        owner.take().unwrap().stop();
        assert!(state(result["parent"].as_u64().unwrap()).is_none());
        stopped(result["descendant"].as_u64().unwrap());
    }

    #[test]
    fn failed_replacement_preserves_the_old_owner_and_success_cleans_its_group() {
        let old = Fixture::new();
        let failed = Fixture::new();
        let new = Fixture::new();
        let mut owner = None;
        old.copy("ready", "old fixture", &mut owner, TIMEOUT)
            .unwrap();
        let previous_pid = owner_pid(&owner);
        let old_descendant = old.result()["descendant"].as_u64().unwrap();
        assert!(failed
            .copy(
                "read-hang",
                "replacement",
                &mut owner,
                Duration::from_millis(150)
            )
            .is_err());
        assert_eq!(owner_pid(&owner), previous_pid);
        assert!(!matches!(state(old_descendant), None | Some('Z')));
        new.copy("ready", "new fixture", &mut owner, TIMEOUT)
            .unwrap();
        assert_ne!(owner_pid(&owner), previous_pid);
        assert!(state(previous_pid).is_none());
        stopped(old_descendant);
        stopped(failed.result()["descendant"].as_u64().unwrap());
        assert!(!matches!(
            state(new.result()["descendant"].as_u64().unwrap()),
            None | Some('Z')
        ));
        owner.take().unwrap().stop();
        stopped(new.result()["descendant"].as_u64().unwrap());
    }

    #[test]
    fn normal_drop_reaps_only_the_parent_and_preserves_background_clipboard() {
        let fixture = Fixture::new();
        let mut owner = None;
        fixture
            .copy("persist", "persisting fixture", &mut owner, TIMEOUT)
            .unwrap();
        let parent = owner_pid(&owner);
        let descendant = fixture.result()["descendant"].as_u64().unwrap();
        drop(owner.take());
        assert!(state(parent).is_none());
        assert!(!matches!(state(descendant), None | Some('Z')));
        stopped(descendant); // The owned fake exits itself after one second.
    }

    #[test]
    fn explicit_finish_stops_the_pinned_wayland_owner_and_its_descendants() {
        let fixture = Fixture::new();
        let mut owner = None;
        fixture
            .copy("ready", "owned fixture", &mut owner, TIMEOUT)
            .unwrap();
        let result = fixture.result();
        owner.take().unwrap().finish();
        assert!(state(result["parent"].as_u64().unwrap()).is_none());
        stopped(result["descendant"].as_u64().unwrap());
    }

    #[test]
    fn queued_copy_cannot_start_a_helper_after_shutdown() {
        use std::sync::{mpsc, Arc};
        let clipboard = Arc::new(Clipboard::default());
        let guard = clipboard.owner.lock().unwrap();
        let fixture = Fixture::new();
        let command = fixture.command("ready");
        let queued = clipboard.clone();
        let (send, receive) = mpsc::channel();
        let copy = std::thread::spawn(move || {
            send.send(()).unwrap();
            queued.deliver(|owner| copy_with(command, "queued fixture", owner, true, TIMEOUT))
        });
        receive.recv().unwrap();
        let exiting = clipboard.clone();
        let exit = std::thread::spawn(move || exiting.shutdown());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !clipboard.shutting_down.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        drop(guard);
        exit.join().unwrap();
        assert_eq!(copy.join().unwrap(), Err(FAILED.into()));
        assert!(!fixture.0.join("result.json").exists());
        assert!(clipboard.owner.lock().unwrap().is_none());
    }

    #[test]
    fn x11_keeps_its_foreground_readiness_and_replacement_policy() {
        let fixture = Fixture::new();
        let mut owner = None;
        copy_with(
            fixture.command("x11"),
            "X11 fixture",
            &mut owner,
            false,
            TIMEOUT,
        )
        .unwrap();
        let parent = owner_pid(&owner);
        assert!(!matches!(state(parent), None | Some('Z')));
        owner.take().unwrap().finish();
        assert!(state(parent).is_none());
    }

    #[test]
    fn missing_helper_has_a_redacted_error_and_preserves_the_owner() {
        let fixture = Fixture::new();
        let mut owner = None;
        fixture
            .copy("ready", "old fixture", &mut owner, TIMEOUT)
            .unwrap();
        let previous = owner_pid(&owner);
        let error = copy_with(
            Command::new(Path::new("/nonexistent/openwhisper-private-helper")),
            "sensitive fixture",
            &mut owner,
            true,
            TIMEOUT,
        )
        .unwrap_err();
        assert!(!error.contains("sensitive") && !error.contains("nonexistent"));
        assert_eq!(owner_pid(&owner), previous);
        owner.take().unwrap().stop();
        stopped(fixture.result()["descendant"].as_u64().unwrap());
    }

    #[test]
    fn lost_parent_pin_never_signals_a_numeric_group() {
        use rustix::process::{pidfd_open, pidfd_send_signal, PidfdFlags};
        let fixture = Fixture::new();
        let mut owner = None;
        fixture
            .copy("ready", "owned fixture", &mut owner, TIMEOUT)
            .unwrap();
        let descendant = fixture.result()["descendant"].as_u64().unwrap();
        let exact_child = pidfd_open(
            Pid::from_raw(descendant as i32).unwrap(),
            PidfdFlags::empty(),
        )
        .unwrap();
        // Only this negative fixture deliberately violates exclusive ownership.
        owner
            .as_mut()
            .unwrap()
            .child
            .as_mut()
            .unwrap()
            .wait()
            .unwrap();
        owner.take().unwrap().stop();
        assert!(!matches!(state(descendant), None | Some('Z')));
        pidfd_send_signal(exact_child, Signal::KILL).unwrap();
        stopped(descendant);
    }
}
