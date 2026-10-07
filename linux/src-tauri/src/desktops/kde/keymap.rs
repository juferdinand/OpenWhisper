//! Surface-free compositor keyboard metadata, used only to validate mouse surrogates.
//! No pointer is bound, and keyboard input/focus/modifier events are neither stored nor used.

use rustix::{
    event::{poll, PollFd, PollFlags, Timespec},
    net::{
        connect as connect_socket, socket_with, sockopt, AddressFamily, SocketAddrUnix,
        SocketFlags, SocketType,
    },
};
use std::{
    collections::BTreeMap,
    fs::File,
    os::{fd::OwnedFd, unix::fs::FileExt, unix::net::UnixStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::watch;
use wayland_client::{
    protocol::{wl_callback, wl_keyboard, wl_registry, wl_seat},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use xkbcommon::xkb;

pub const UNSUPPORTED: &str = "This desktop keyboard layout cannot safely provide a mouse trigger. Use a keyboard trigger or the Record button.";
pub const UNVERIFIED: &str = "Could not verify the desktop keyboard layout for a mouse trigger. Use a keyboard trigger or the Record button.";
pub const CHANGED: &str = "The desktop keyboard layout changed and the mouse trigger stopped. Set it again, or use a keyboard trigger or the Record button.";
const SETUP_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_MAP_BYTES: u32 = 1024 * 1024;
const MAX_SEATS: usize = 16;
const MAX_KEYCODE: u32 = 8192;
const MAX_LAYOUTS: u32 = 32;
const MAX_LEVELS: u32 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SafeKeys([bool; 2]);

impl SafeKeys {
    pub fn contains(self, qt_key: i32) -> bool {
        match qt_key {
            0x01000042 => self.0[0], // F19
            0x01000047 => self.0[1], // F24
            _ => false,
        }
    }
    fn intersect(self, other: Self) -> Self {
        Self([self.0[0] && other.0[0], self.0[1] && other.0[1]])
    }
}

fn evaluate(text: String) -> Result<SafeKeys, &'static str> {
    let mut context =
        xkb::Context::new(xkb::CONTEXT_NO_DEFAULT_INCLUDES | xkb::CONTEXT_NO_ENVIRONMENT_NAMES);
    // Invalid metadata must not print map fragments or device/layout names.
    context.set_log_level(xkb::LogLevel::Critical);
    let map = xkb::Keymap::new_from_string(
        &context,
        text,
        xkb::KEYMAP_FORMAT_TEXT_V1,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .ok_or(UNVERIFIED)?;
    if map.max_keycode().raw() > MAX_KEYCODE || !(1..=MAX_LAYOUTS).contains(&map.num_layouts()) {
        return Err(UNVERIFIED);
    }
    let mut safe = SafeKeys([true; 2]);
    let mut first_codes = [None; 2];
    for layout in 0..map.num_layouts() {
        for (index, symbol) in [xkb::Keysym::new(0xffd0), xkb::Keysym::new(0xffd5)]
            .into_iter()
            .enumerate()
        {
            let mut first = None;
            // Match KWin's first-keycode, first-level, first-symbol search exactly,
            // including its excluded maximum keycode. A later unshifted duplicate
            // cannot rescue an earlier shifted match that KWin would choose.
            'keys: for code in map.min_keycode().raw()..map.max_keycode().raw() {
                let key = xkb::Keycode::new(code);
                let levels = map.num_levels_for_key(key, layout);
                if levels > MAX_LEVELS {
                    return Err(UNVERIFIED);
                }
                for level in 0..levels {
                    if map
                        .key_get_syms_by_level(key, layout, level)
                        .contains(&symbol)
                    {
                        first = Some((key, level));
                        break 'keys;
                    }
                }
            }
            // Also reject multi-symbol levels and unusual group/type redirects:
            // KWin interprets the emitted event with key_get_one_sym as well.
            safe.0[index] &= first.is_some_and(|(key, level)| {
                if level != 0 {
                    return false;
                }
                // KWin looks up the release again in the then-current layout.
                // A layout switch must not make it release another keycode.
                let original_code = first_codes[index].get_or_insert(key.raw());
                if *original_code != key.raw() {
                    return false;
                }
                let mut state = xkb::State::new(&map);
                state.update_mask(0, 0, 0, 0, 0, layout);
                let original_groups = groups(&state);
                let unchanged = |state: &xkb::State| {
                    state.key_get_one_sym(key) == symbol
                        && state.serialize_mods(
                            xkb::STATE_MODS_DEPRESSED
                                | xkb::STATE_MODS_LATCHED
                                | xkb::STATE_MODS_LOCKED
                                | xkb::STATE_MODS_EFFECTIVE,
                        ) == 0
                        && groups(state) == original_groups
                };
                if !unchanged(&state) {
                    return false;
                }
                // Level zero can still carry SetMods/LockMods/SetGroup actions.
                // Simulate metadata only; never inject a real key event.
                state.update_key(key, xkb::KeyDirection::Down);
                if !unchanged(&state) {
                    return false;
                }
                state.update_key(key, xkb::KeyDirection::Up);
                unchanged(&state)
            });
        }
    }
    Ok(safe)
}

fn groups(state: &xkb::State) -> [u32; 4] {
    [
        xkb::STATE_LAYOUT_DEPRESSED,
        xkb::STATE_LAYOUT_LATCHED,
        xkb::STATE_LAYOUT_LOCKED,
        xkb::STATE_LAYOUT_EFFECTIVE,
    ]
    .map(|component| state.serialize_layout(component))
}

fn read_map(fd: OwnedFd, size: u32) -> Result<SafeKeys, &'static str> {
    if !(2..=MAX_MAP_BYTES).contains(&size) {
        return Err(UNVERIFIED);
    }
    let file = File::from(fd);
    let metadata = file.metadata().map_err(|_| UNVERIFIED)?;
    // Reject pipes/devices/sockets before reading; pread of a bounded regular
    // shared-memory file avoids a blocked read or a SIGBUS-prone mmap.
    if !metadata.is_file()
        || metadata.len() < u64::from(size)
        || metadata.len() > u64::from(MAX_MAP_BYTES)
    {
        return Err(UNVERIFIED);
    }
    let mut bytes = vec![0; size as usize];
    file.read_exact_at(&mut bytes, 0).map_err(|_| UNVERIFIED)?;
    if bytes.pop() != Some(0) || bytes.contains(&0) {
        return Err(UNVERIFIED);
    }
    evaluate(String::from_utf8(bytes).map_err(|_| UNVERIFIED)?)
}

#[derive(Default)]
struct Seat {
    keyboard: Option<wl_keyboard::WlKeyboard>,
    keyboard_available: Option<bool>,
    safe: Option<SafeKeys>,
}

#[derive(Default)]
struct Metadata {
    seats: BTreeMap<u32, Seat>,
    registry_done: bool,
    failed: bool,
    revision: u64,
}

impl Metadata {
    fn safe(&self) -> Result<Option<SafeKeys>, &'static str> {
        if self.failed {
            return Err(UNVERIFIED);
        }
        if !self.registry_done {
            return Ok(None);
        }
        if self.seats.is_empty() {
            return Err(UNVERIFIED);
        }
        let mut all = SafeKeys([true; 2]);
        for seat in self.seats.values() {
            match seat.keyboard_available {
                None => return Ok(None),
                Some(false) => return Err(UNVERIFIED),
                Some(true) => {}
            }
            let Some(safe) = seat.safe else {
                return Ok(None);
            };
            all = all.intersect(safe);
        }
        Ok(Some(all))
    }
    fn accept_map(&mut self, name: u32, fd: OwnedFd, size: u32, xkb_v1: bool) {
        self.revision += 1;
        if self.failed {
            return;
        }
        let result = if xkb_v1 {
            read_map(fd, size)
        } else {
            Err(UNVERIFIED)
        };
        match (self.seats.get_mut(&name), result) {
            (Some(seat), Ok(safe)) => seat.safe = Some(safe),
            _ => self.failed = true,
        }
    }
    fn unchanged_since(&self, revision: u64) -> bool {
        !self.failed && self.revision == revision
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Metadata {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } if interface == "wl_seat" => {
                if state.seats.len() >= MAX_SEATS || version == 0 {
                    state.failed = true;
                    return;
                }
                registry.bind::<wl_seat::WlSeat, _, _>(name, version.min(7), qh, name);
                state.seats.insert(name, Seat::default());
                state.revision += 1;
            }
            wl_registry::Event::GlobalRemove { name } if state.seats.remove(&name).is_some() => {
                state.revision += 1;
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, ()> for Metadata {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.registry_done = true;
    }
}

impl Dispatch<wl_seat::WlSeat, u32> for Metadata {
    fn event(
        state: &mut Self,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        name: &u32,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities { capabilities } = event {
            let Some(data) = state.seats.get_mut(name) else {
                return;
            };
            let keyboard_available = matches!(capabilities, WEnum::Value(c) if c.contains(wl_seat::Capability::Keyboard));
            if data.keyboard_available != Some(keyboard_available) {
                state.revision += 1;
            }
            data.keyboard_available = Some(keyboard_available);
            if keyboard_available {
                if data.keyboard.is_none() {
                    data.keyboard = Some(seat.get_keyboard(qh, *name));
                }
            } else {
                if let Some(keyboard) = data.keyboard.take() {
                    if keyboard.version() >= 3 {
                        keyboard.release();
                    }
                }
                data.safe = None;
            }
        }
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, u32> for Metadata {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        name: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // We create no wl_surface and cannot receive focus. Explicitly ignore
        // all input/enter/leave/modifier events; only keymap metadata is used.
        if let wl_keyboard::Event::Keymap { format, fd, size } = event {
            state.accept_map(
                *name,
                fd,
                size,
                matches!(format, WEnum::Value(wl_keyboard::KeymapFormat::XkbV1)),
            );
        }
    }
}

fn ready_fd(
    fd: &impl std::os::fd::AsFd,
    flags: PollFlags,
    duration: Duration,
) -> Result<bool, &'static str> {
    let mut fds = [PollFd::new(fd, flags)];
    let timeout = Timespec::try_from(duration).map_err(|_| UNVERIFIED)?;
    match poll(&mut fds, Some(&timeout)) {
        Ok(0) => Ok(false),
        Ok(_)
            if fds[0]
                .revents()
                .intersects(PollFlags::ERR | PollFlags::HUP | PollFlags::NVAL) =>
        {
            Err(UNVERIFIED)
        }
        Ok(_) => Ok(true),
        Err(rustix::io::Errno::INTR) => Ok(false),
        Err(_) => Err(UNVERIFIED),
    }
}

fn connect(path: &Path, deadline: Instant) -> Result<Connection, &'static str> {
    let fd = socket_with(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
        None,
    )
    .map_err(|_| UNVERIFIED)?;
    let address = SocketAddrUnix::new(path).map_err(|_| UNVERIFIED)?;
    match connect_socket(&fd, &address) {
        Ok(()) => {}
        Err(rustix::io::Errno::INPROGRESS) => {
            if !ready_fd(
                &fd,
                PollFlags::OUT,
                deadline.saturating_duration_since(Instant::now()),
            )? {
                return Err(UNVERIFIED);
            }
            sockopt::socket_error(&fd)
                .map_err(|_| UNVERIFIED)?
                .map_err(|_| UNVERIFIED)?;
        }
        Err(_) => return Err(UNVERIFIED),
    }
    Connection::from_socket(UnixStream::from(fd)).map_err(|_| UNVERIFIED)
}

struct Observer {
    connection: Connection,
    queue: EventQueue<Metadata>,
    metadata: Metadata,
}

impl Observer {
    fn new(path: &Path, deadline: Instant) -> Result<Self, &'static str> {
        let connection = connect(path, deadline)?;
        let queue = connection.new_event_queue();
        let qh = queue.handle();
        connection.display().get_registry(&qh, ());
        connection.display().sync(&qh, ());
        Ok(Self {
            connection,
            queue,
            metadata: Metadata::default(),
        })
    }
    fn pump(&mut self, duration: Duration) -> Result<(), &'static str> {
        self.queue
            .dispatch_pending(&mut self.metadata)
            .map_err(|_| UNVERIFIED)?;
        // Both connection and reads are nonblocking. Never use roundtrip or
        // blocking_dispatch: a missing or hung compositor has a finite deadline.
        self.connection.flush().map_err(|_| UNVERIFIED)?;
        if let Some(guard) = self.queue.prepare_read() {
            if ready_fd(&guard.connection_fd(), PollFlags::IN, duration)? {
                guard.read().map_err(|_| UNVERIFIED)?;
            }
        }
        self.queue
            .dispatch_pending(&mut self.metadata)
            .map_err(|_| UNVERIFIED)?;
        Ok(())
    }
    fn initial(&mut self, deadline: Instant, stop: &AtomicBool) -> Result<SafeKeys, &'static str> {
        loop {
            if stop.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return Err(UNVERIFIED);
            }
            self.pump(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())))?;
            if stop.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return Err(UNVERIFIED);
            }
            if let Some(safe) = self.metadata.safe()? {
                return Ok(safe);
            }
        }
    }
}

pub struct Monitor {
    receiver: watch::Receiver<Option<Result<SafeKeys, &'static str>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Monitor {
    pub async fn start() -> Result<Self, String> {
        // Deliberately open a new connection, never consume WAYLAND_SOCKET from
        // another client. Only the advertised display socket is contacted.
        let display = std::env::var_os("WAYLAND_DISPLAY").ok_or(UNVERIFIED)?;
        let mut path = PathBuf::from(display);
        if !path.is_absolute() {
            if path.components().count() != 1 {
                return Err(UNVERIFIED.into());
            }
            let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or(UNVERIFIED)?);
            if !runtime.is_absolute() {
                return Err(UNVERIFIED.into());
            }
            path = runtime.join(path);
        }
        let (sender, receiver) = watch::channel(None);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::Builder::new()
            .name("mouse-keymap".into())
            .spawn(move || {
                let deadline = Instant::now() + SETUP_TIMEOUT;
                let initial = Observer::new(&path, deadline).and_then(|mut observer| {
                    observer
                        .initial(deadline, &stopped)
                        .map(|safe| (observer, safe))
                });
                let (mut observer, safe) = match initial {
                    Ok(value) => value,
                    Err(error) => {
                        sender.send_replace(Some(Err(error)));
                        return;
                    }
                };
                sender.send_replace(Some(Ok(safe)));
                let initial_revision = observer.metadata.revision;
                while !stopped.load(Ordering::Relaxed) {
                    if observer.pump(POLL_INTERVAL).is_err()
                        || !observer.metadata.unchanged_since(initial_revision)
                    {
                        // Even a safe-to-safe replacement may move a held keycode.
                        // Stop rather than guessing a release from an unfocused client.
                        sender.send_replace(Some(Err(CHANGED)));
                        break;
                    }
                }
            })
            .map_err(|_| UNVERIFIED)?;
        let mut monitor = Self {
            receiver,
            stop,
            worker: Some(worker),
        };
        monitor.changed().await?;
        Ok(monitor)
    }
    pub fn current(&self) -> Result<SafeKeys, String> {
        self.receiver
            .borrow()
            .as_ref()
            .copied()
            .ok_or(UNVERIFIED)?
            .map_err(str::to_owned)
    }
    pub async fn changed(&mut self) -> Result<SafeKeys, String> {
        self.receiver.changed().await.map_err(|_| UNVERIFIED)?;
        self.current()
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, io::Write, os::unix::net::UnixListener, sync::atomic::AtomicU64};

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "openwhisper-keymap-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn fd(&self, name: &str, bytes: &[u8]) -> OwnedFd {
            let mut file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(self.0.join(name))
                .unwrap();
            file.write_all(bytes).unwrap();
            file.into()
        }
        fn map(&self, name: &str, text: String) -> (OwnedFd, u32) {
            let mut bytes = text.into_bytes();
            bytes.push(0);
            (self.fd(name, &bytes), bytes.len() as u32)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(symbols: &str) -> String {
        format!(
            r#"xkb_keymap {{
            xkb_keycodes "fixture" {{ minimum = 8; maximum = 50;
                <A> = 10; <B> = 11; <C> = 12; <D> = 13; <END> = 50;
            }};
            xkb_types "fixture" {{
                type "ONE_LEVEL" {{ modifiers = None; level_name[Level1] = "Any"; }};
                type "TWO_LEVEL" {{ modifiers = Shift; map[Shift] = Level2;
                    level_name[Level1] = "Base"; level_name[Level2] = "Shift";
                }};
            }};
            xkb_compatibility "fixture" {{}};
            xkb_symbols "fixture" {{ {symbols} }};
        }};"#
        )
    }

    #[test]
    fn missing_and_unmodified_surrogates_are_distinguished() {
        assert_eq!(
            evaluate(fixture("key <A> { [ a ] };")).unwrap(),
            SafeKeys([false, false])
        );
        assert_eq!(
            evaluate(fixture("key <A> { [ F19 ] }; key <B> { [ F24 ] };")).unwrap(),
            SafeKeys([true, true])
        );
    }

    #[test]
    fn earlier_shifted_duplicate_is_not_rescued_by_later_unmodified_symbol() {
        let map = fixture(
            "key <A> { type=\"TWO_LEVEL\", [ a, F19 ] }; key <B> { [ F19 ] }; key <C> { [ F24 ] };",
        );
        assert_eq!(evaluate(map).unwrap(), SafeKeys([false, true]));
    }

    #[test]
    fn surrogate_must_use_the_same_first_keycode_in_every_layout() {
        // Both groups can emit F19 unmodified, but switching group while a mouse
        // button is held would make KWin release a different synthetic keycode.
        // Nonempty alternate groups prevent XKB's trailing-NoSymbol fallback
        // from normalizing the intended keycode change away.
        let map = fixture("key <A> { symbols[Group1]=[F19], symbols[Group2]=[a] }; key <B> { symbols[Group1]=[b], symbols[Group2]=[F19] }; key <C> { [ F24 ] };");
        assert_eq!(evaluate(map).unwrap(), SafeKeys([false, true]));
    }

    #[test]
    fn a_symbol_absent_in_one_layout_is_not_safe() {
        let map =
            fixture("key <A> { symbols[Group1]=[F19], symbols[Group2]=[a] }; key <B> { [ F24 ] };");
        assert_eq!(evaluate(map).unwrap(), SafeKeys([false, true]));
    }

    #[test]
    fn level_zero_symbol_must_not_activate_a_modifier_action() {
        let map = fixture(
            "key <A> { [ F19 ], actions[Group1]=[SetMods(modifiers=Shift)] }; key <B> { [ F24 ] };",
        );
        assert_eq!(evaluate(map).unwrap(), SafeKeys([false, true]));
    }

    #[test]
    fn modifier_lock_and_group_actions_are_rejected() {
        for action in [
            "LockMods(modifiers=Shift)",
            "SetGroup(group=+1)",
            "LockGroup(group=+1)",
        ] {
            let map = fixture(&format!("key <A> {{ symbols[Group1]=[F19], symbols[Group2]=[F19], actions[Group1]=[{action}], actions[Group2]=[{action}] }}; key <B> {{ [ F24 ] }};"));
            assert_eq!(evaluate(map).unwrap(), SafeKeys([false, true]), "{action}");
        }
    }

    #[test]
    fn multiple_symbols_at_first_match_are_not_a_single_safe_key() {
        let map = fixture("key <A> { [ { F19, a } ] }; key <B> { [ F19 ] }; key <C> { [ F24 ] };");
        assert_eq!(evaluate(map).unwrap(), SafeKeys([false, true]));
    }

    #[test]
    fn stable_keycodes_in_all_layouts_are_accepted() {
        let map = fixture("key <A> { symbols[Group1]=[F19], symbols[Group2]=[F19] }; key <B> { symbols[Group1]=[F24], symbols[Group2]=[F24] };");
        assert_eq!(evaluate(map).unwrap(), SafeKeys([true, true]));
    }

    #[test]
    fn maximum_keycode_is_excluded_like_kwin() {
        assert_eq!(
            evaluate(fixture("key <END> { [ F19 ] }; key <B> { [ F24 ] };")).unwrap(),
            SafeKeys([false, true])
        );
    }

    #[test]
    fn malformed_keymap_is_rejected_without_includes() {
        assert_eq!(evaluate("invalid keymap".into()), Err(UNVERIFIED));
        assert_eq!(
            evaluate("xkb_keymap { xkb_symbols { include \"inet(evdev)\" }; };".into()),
            Err(UNVERIFIED)
        );
    }

    #[test]
    fn fd_metadata_size_truncation_and_termination_are_bounded() {
        let dir = Directory::new();
        let (fd, size) = dir.map(
            "valid",
            fixture("key <A> { [ F19 ] }; key <B> { [ F24 ] };"),
        );
        assert_eq!(read_map(fd, size).unwrap(), SafeKeys([true, true]));
        for (name, bytes, size) in [
            ("zero", b"".as_slice(), 0),
            ("huge-declared", b"x\0", MAX_MAP_BYTES + 1),
            ("truncated", b"x\0", 3),
            ("no-nul", b"xx", 2),
            ("embedded-nul", b"x\0\0", 3),
            ("invalid-utf8", b"\xff\0", 2),
        ] {
            assert_eq!(
                read_map(dir.fd(name, bytes), size),
                Err(UNVERIFIED),
                "{name}"
            );
        }
        let fd = dir.fd("huge-file", b"x\0");
        let file = File::from(fd);
        file.set_len(u64::from(MAX_MAP_BYTES) + 1).unwrap();
        assert_eq!(read_map(file.into(), 2), Err(UNVERIFIED));
        let (socket, _peer) = UnixStream::pair().unwrap();
        assert_eq!(read_map(socket.into(), 2), Err(UNVERIFIED));
    }

    #[test]
    fn every_seat_requires_complete_compatible_metadata() {
        let mut metadata = Metadata {
            registry_done: true,
            ..Metadata::default()
        };
        let first = Seat {
            keyboard_available: Some(true),
            safe: Some(SafeKeys([true, true])),
            ..Seat::default()
        };
        metadata.seats.insert(1, first);
        metadata.seats.insert(
            2,
            Seat {
                keyboard_available: Some(true),
                ..Seat::default()
            },
        );
        assert_eq!(metadata.safe(), Ok(None));
        metadata.seats.get_mut(&2).unwrap().safe = Some(SafeKeys([false, true]));
        assert_eq!(metadata.safe(), Ok(Some(SafeKeys([false, true]))));
        metadata.seats.get_mut(&2).unwrap().keyboard_available = Some(false);
        assert_eq!(metadata.safe(), Err(UNVERIFIED));
    }

    #[test]
    fn safe_to_safe_keymap_replacement_invalidates_the_active_revision() {
        let dir = Directory::new();
        let mut metadata = Metadata {
            registry_done: true,
            ..Metadata::default()
        };
        metadata.seats.insert(
            1,
            Seat {
                keyboard_available: Some(true),
                ..Seat::default()
            },
        );
        let (fd, size) = dir.map(
            "first",
            fixture("key <A> { [ F19 ] }; key <C> { [ F24 ] };"),
        );
        metadata.accept_map(1, fd, size, true);
        let before = metadata.safe().unwrap();
        let revision = metadata.revision;
        let (fd, size) = dir.map(
            "moved",
            fixture("key <B> { [ F19 ] }; key <C> { [ F24 ] };"),
        );
        metadata.accept_map(1, fd, size, true);
        assert_eq!(metadata.safe().unwrap(), before);
        assert!(!metadata.unchanged_since(revision));
        let (fd, size) = dir.map("unknown-format", fixture("key <A> { [ F19 ] };"));
        metadata.accept_map(1, fd, size, false);
        assert_eq!(metadata.safe(), Err(UNVERIFIED));
    }

    #[test]
    fn missing_and_unresponsive_owned_sockets_have_finite_setup() {
        let dir = Directory::new();
        assert!(Observer::new(
            &dir.0.join("missing"),
            Instant::now() + Duration::from_millis(80)
        )
        .is_err());
        let path = dir.0.join("silent");
        let _listener = UnixListener::bind(&path).unwrap();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(80);
        let mut observer = Observer::new(&path, deadline).unwrap();
        assert_eq!(
            observer.initial(deadline, &AtomicBool::new(false)),
            Err(UNVERIFIED)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
