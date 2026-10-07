//! Xlib is confined to the disposable helper, never the GTK process.
use super::Trigger;
use std::{
    ffi::CString,
    mem,
    os::raw::c_int,
    sync::atomic::{AtomicU8, Ordering},
};
use x11_dl::{xlib, xtest};

static LAST_ERROR: AtomicU8 = AtomicU8::new(0);
const CORE_KEYBOARD: u32 = 0x100;
const UNAVAILABLE: &str =
    "Native X11 keyboard support is unavailable. Use the Record button and clipboard output.";

unsafe extern "C" fn error_handler(
    _display: *mut xlib::Display,
    event: *mut xlib::XErrorEvent,
) -> c_int {
    // Xlib invokes this synchronously while this helper processes its own connection.
    LAST_ERROR.store(unsafe { (*event).error_code }, Ordering::Relaxed);
    0
}

// Match X11/extensions/XKBstr.h. x11-dl 2.21.0 misplaces locked_group,
// making its mods field read base_mods and miss sticky/locked modifiers.
#[repr(C)]
#[derive(Default)]
struct KeyboardState {
    group: u8,
    locked_group: u8,
    base_group: u16,
    latched_group: u16,
    mods: u8,
    base_mods: u8,
    latched_mods: u8,
    locked_mods: u8,
    compat_state: u8,
    grab_mods: u8,
    compat_grab_mods: u8,
    lookup_mods: u8,
    compat_lookup_mods: u8,
    ptr_buttons: u16,
}

pub struct Connection {
    pub lib: xlib::Xlib,
    pub display: *mut xlib::Display,
    roots: Vec<xlib::Window>,
    pub xkb_event: c_int,
    old_handler: Option<unsafe extern "C" fn(*mut xlib::Display, *mut xlib::XErrorEvent) -> c_int>,
}

impl Connection {
    pub fn open(name: &str) -> Result<Self, String> {
        // Only a local numeric UNIX display bound by the GTK host is supported.
        let suffix = name.strip_prefix(':').ok_or(UNAVAILABLE)?;
        if suffix.is_empty()
            || suffix.len() > 32
            || suffix.split('.').count() > 2
            || suffix
                .split('.')
                .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(UNAVAILABLE.into());
        }
        let lib = xlib::Xlib::open().map_err(|_| UNAVAILABLE)?;
        let name = CString::new(name).map_err(|_| UNAVAILABLE)?;
        // No Xlib connection or process-global error handler is shared with GTK.
        let display = unsafe { (lib.XOpenDisplay)(name.as_ptr()) };
        if display.is_null() {
            return Err(UNAVAILABLE.into());
        }
        let old_handler = unsafe { (lib.XSetErrorHandler)(Some(error_handler)) };
        let roots = unsafe {
            (0..(lib.XScreenCount)(display))
                .map(|screen| (lib.XRootWindow)(display, screen))
                .collect()
        };
        let mut connection = Self {
            lib,
            display,
            roots,
            xkb_event: 0,
            old_handler,
        };
        let (mut opcode, mut error, mut major, mut minor) = (0, 0, 1, 0);
        let present = unsafe {
            (connection.lib.XkbQueryExtension)(
                display,
                &mut opcode,
                &mut connection.xkb_event,
                &mut error,
                &mut major,
                &mut minor,
            )
        };
        let mut supported = 0;
        let repeat =
            unsafe { (connection.lib.XkbSetDetectableAutoRepeat)(display, 1, &mut supported) };
        if present == 0 || supported == 0 || repeat == 0 {
            return Err(UNAVAILABLE.into());
        }
        connection.sync()?;
        Ok(connection)
    }

    pub fn sync(&self) -> Result<(), String> {
        unsafe {
            (self.lib.XSync)(self.display, 0);
        }
        match LAST_ERROR.swap(0, Ordering::Relaxed) {
            0 => Ok(()),
            10 => Err("This shortcut is already reserved by another X11 application. Choose another trigger.".into()),
            _ => Err(UNAVAILABLE.into()),
        }
    }

    fn ignored_locks(&self) -> Result<u32, String> {
        let map = unsafe { (self.lib.XGetModifierMapping)(self.display) };
        if map.is_null() {
            return Err(UNAVAILABLE.into());
        }
        let mut ignored = xlib::LockMask;
        unsafe {
            let map_ref = &*map;
            if !(1..=32).contains(&map_ref.max_keypermod) || map_ref.modifiermap.is_null() {
                (self.lib.XFreeModifiermap)(map);
                return Err(UNAVAILABLE.into());
            }
            for modifier in 0..8 {
                for index in 0..map_ref.max_keypermod {
                    let keycode = *map_ref
                        .modifiermap
                        .add((modifier * map_ref.max_keypermod + index) as usize);
                    if keycode == 0 {
                        continue;
                    }
                    for level in 0..4 {
                        let symbol = (self.lib.XkbKeycodeToKeysym)(self.display, keycode, 0, level);
                        if [0xff7f, 0xff14, 0xffe5].contains(&symbol) {
                            ignored |= 1 << modifier;
                        }
                    }
                }
            }
            (self.lib.XFreeModifiermap)(map);
        }
        self.sync()?;
        Ok(ignored)
    }

    pub fn bind(&self, trigger: &Trigger) -> Result<Trigger, String> {
        trigger.validate()?;
        let mut state = KeyboardState::default();
        if unsafe {
            (self.lib.XkbGetState)(
                self.display,
                CORE_KEYBOARD,
                (&mut state as *mut KeyboardState).cast(),
            )
        } != 0
            || u32::from(state.group) != trigger.group
        {
            return Err("The keyboard layout changed. Set the X11 trigger again.".into());
        }
        let ignored = self.ignored_locks()?;
        let wanted = Trigger {
            modifiers: trigger.modifiers & !ignored,
            ..trigger.clone()
        };
        // XKB levels also depend on AltGr/virtual modifiers, not only Shift.
        let symbol_for = |modifiers| {
            let mut symbol = 0;
            let mut remaining = 0;
            let available = unsafe {
                (self.lib.XkbLookupKeySym)(
                    self.display,
                    trigger.keycode as u8,
                    modifiers | (trigger.group << 13),
                    &mut remaining,
                    &mut symbol,
                )
            };
            let mut lower = 0;
            let mut upper = 0;
            unsafe {
                (self.lib.XConvertCase)(symbol, &mut lower, &mut upper);
            }
            if available != 0 {
                Some(lower)
            } else {
                None
            }
        };
        if symbol_for(wanted.modifiers) != Some(u64::from(trigger.keysym)) {
            if trigger.modifiers & ignored != 0
                && symbol_for(trigger.modifiers) == Some(u64::from(trigger.keysym))
            {
                return Err("This key depends on the current keyboard lock state. Choose another X11 trigger.".into());
            }
            return Err("The keyboard layout changed. Set the X11 trigger again.".into());
        }
        let locks: Vec<u32> = (0..8)
            .filter(|bit| ignored & (1 << bit) != 0)
            .map(|bit| 1 << bit)
            .collect();
        let variants: Vec<u32> = (0..(1 << locks.len()))
            .map(|bits| {
                locks
                    .iter()
                    .enumerate()
                    .fold(wanted.modifiers, |value, (index, mask)| {
                        value | if bits & (1 << index) != 0 { *mask } else { 0 }
                    })
            })
            .collect();
        for root in &self.roots {
            for modifiers in &variants {
                unsafe {
                    (self.lib.XGrabKey)(
                        self.display,
                        wanted.keycode as c_int,
                        *modifiers,
                        *root,
                        0,
                        xlib::GrabModeAsync,
                        xlib::GrabModeAsync,
                    );
                }
                if let Err(error) = self.sync() {
                    self.ungrab();
                    return Err(error);
                }
            }
        }
        // Mapping/group changes invalidate this exact captured key instead of moving its binding.
        unsafe {
            (self.lib.XkbSelectEvents)(
                self.display,
                CORE_KEYBOARD,
                xlib::XkbNewKeyboardNotifyMask | xlib::XkbMapNotifyMask,
                xlib::XkbNewKeyboardNotifyMask | xlib::XkbMapNotifyMask,
            );
            (self.lib.XkbSelectEventDetails)(
                self.display,
                CORE_KEYBOARD,
                xlib::XkbStateNotify as u32,
                xlib::XkbGroupStateMask,
                xlib::XkbGroupStateMask,
            );
        }
        self.sync()?;
        Ok(wanted)
    }

    pub fn next_event(&self) -> Option<xlib::XEvent> {
        if unsafe { (self.lib.XPending)(self.display) } == 0 {
            return None;
        }
        let mut event = unsafe { mem::zeroed() };
        unsafe {
            (self.lib.XNextEvent)(self.display, &mut event);
        }
        Some(event)
    }

    pub fn paste_supported(&self) -> bool {
        let Ok(test) = xtest::Xf86vmode::open() else {
            return false;
        };
        let (mut event, mut error, mut major, mut minor) = (0, 0, 0, 0);
        unsafe {
            (test.XTestQueryExtension)(self.display, &mut event, &mut error, &mut major, &mut minor)
                != 0
                && major >= 2
        }
    }

    pub fn paste(&self) -> Result<(), String> {
        let test = xtest::Xf86vmode::open().map_err(|_| UNAVAILABLE)?;
        if !self.paste_supported() {
            return Err(UNAVAILABLE.into());
        }
        let control = unsafe { (self.lib.XKeysymToKeycode)(self.display, 0xffe3) };
        let v = unsafe { (self.lib.XKeysymToKeycode)(self.display, b'v'.into()) };
        if control == 0 || v == 0 {
            return Err("Text copied; this keyboard layout has no Ctrl+V paste binding.".into());
        }
        let mut keys = [0i8; 32];
        unsafe {
            (self.lib.XQueryKeymap)(self.display, keys.as_mut_ptr());
        }
        if keys[(v / 8) as usize] as u8 & (1 << (v % 8)) != 0 {
            return Err("Text copied. Release the keyboard modifiers, then paste manually.".into());
        }
        let mut state = KeyboardState::default();
        let mapped = unsafe {
            (self.lib.XkbGetState)(
                self.display,
                CORE_KEYBOARD,
                (&mut state as *mut KeyboardState).cast(),
            ) == 0
                && (self.lib.XkbKeycodeToKeysym)(self.display, v, state.group.into(), 0)
                    == u64::from(b'v')
                && (self.lib.XkbKeycodeToKeysym)(self.display, control, state.group.into(), 0)
                    == 0xffe3
        };
        if !mapped {
            return Err("Text copied; this keyboard layout has no Ctrl+V paste binding.".into());
        }
        let map = unsafe { (self.lib.XGetModifierMapping)(self.display) };
        if map.is_null() {
            return Err(UNAVAILABLE.into());
        }
        let (held, control_mapping) = unsafe {
            let map_ref = &*map;
            let valid = (1..=32).contains(&map_ref.max_keypermod) && !map_ref.modifiermap.is_null();
            let result = if valid {
                let entries = std::slice::from_raw_parts(
                    map_ref.modifiermap,
                    (map_ref.max_keypermod * 8) as usize,
                );
                let held = entries.iter().any(|code| {
                    *code != 0 && keys[(*code / 8) as usize] as u8 & (1 << (*code % 8)) != 0
                });
                let control_mapping = entries
                    .chunks(map_ref.max_keypermod as usize)
                    .enumerate()
                    .all(|(modifier, row)| row.contains(&control) == (modifier == 2));
                (held, control_mapping)
            } else {
                (true, false)
            };
            (self.lib.XFreeModifiermap)(map);
            result
        };
        if !control_mapping {
            return Err("Text copied; this keyboard layout has no Ctrl+V paste binding.".into());
        }
        // Sticky/latched modifiers are input too; never clear or inject through them.
        if held || u32::from(state.mods) & !self.ignored_locks()? != 0 {
            return Err("Text copied. Release the keyboard modifiers, then paste manually.".into());
        }
        let mut focus = 0;
        let mut revert = 0;
        unsafe {
            (self.lib.XGetInputFocus)(self.display, &mut focus, &mut revert);
        }
        if focus <= 1 || self.roots.contains(&focus) {
            return Err("Text copied. Focus a text field, then paste manually.".into());
        }
        self.sync()?;
        let mut success = true;
        // No physical modifier was held. Release both keys even if a request fails.
        for (key, down) in [(control, 1), (v, 1), (v, 0), (control, 0)] {
            success &= unsafe { (test.XTestFakeKeyEvent)(self.display, key.into(), down, 0) != 0 };
        }
        self.sync()?;
        if success {
            Ok(())
        } else {
            Err("Text copied; automatic X11 paste failed. Paste manually.".into())
        }
    }

    fn ungrab(&self) {
        unsafe {
            (self.lib.XUngrabKeyboard)(self.display, xlib::CurrentTime);
            for root in &self.roots {
                (self.lib.XUngrabKey)(self.display, xlib::AnyKey, xlib::AnyModifier, *root);
            }
            (self.lib.XSync)(self.display, 0);
        }
        LAST_ERROR.store(0, Ordering::Relaxed);
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.ungrab();
        unsafe {
            (self.lib.XCloseDisplay)(self.display);
            (self.lib.XSetErrorHandler)(self.old_handler);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyboard_state_matches_the_primary_xkb_c_abi() {
        assert_eq!(mem::size_of::<KeyboardState>(), 18);
        assert_eq!(mem::align_of::<KeyboardState>(), 2);
        assert_eq!(mem::offset_of!(KeyboardState, locked_group), 1);
        assert_eq!(mem::offset_of!(KeyboardState, base_group), 2);
        assert_eq!(mem::offset_of!(KeyboardState, latched_group), 4);
        assert_eq!(mem::offset_of!(KeyboardState, mods), 6);
        assert_eq!(mem::offset_of!(KeyboardState, latched_mods), 8);
        assert_eq!(mem::offset_of!(KeyboardState, locked_mods), 9);
        assert_eq!(mem::offset_of!(KeyboardState, ptr_buttons), 16);
    }
}
