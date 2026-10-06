use gtk::gdk;
use serde::{Deserialize, Serialize};

const SHIFT: i32 = 0x0200_0000;
const CONTROL: i32 = 0x0400_0000;
const ALT: i32 = 0x0800_0000;
const META: i32 = 0x1000_0000;
const KEYPAD: i32 = 0x2000_0000;
const MODIFIERS: i32 = SHIFT | CONTROL | ALT | META | KEYPAD;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Trigger {
    Key { key: i32 },
    Mouse { button: u32 },
}
impl Trigger {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Key { key } if *key >= 0 && key & !(MODIFIERS | 0x01ff_ffff) == 0 => {
                let base = key & !MODIFIERS;
                if keyboard_name(base).is_some() {
                    return Ok(());
                }
            }
            Self::Mouse { button } if *button == 2 || (8..=31).contains(button) => return Ok(()),
            _ => {}
        }
        Err("This key or mouse button is not supported. Use a keyboard key, the middle mouse button, or an extra mouse button.".into())
    }

    pub fn modifier_only(&self) -> bool {
        matches!(self, Self::Key { key } if (0x01000020..=0x01000023).contains(&(key & !MODIFIERS)))
    }

    pub fn label(&self) -> String {
        match self {
            Self::Mouse { button: 2 } => "Middle mouse button".into(),
            Self::Mouse { button: 8 } => "Mouse back button".into(),
            Self::Mouse { button: 9 } => "Mouse forward button".into(),
            Self::Mouse { button } => format!("Mouse button {}", button - 4),
            Self::Key { key } => {
                let mut parts = vec![];
                for (mask, name) in [
                    (CONTROL, "Ctrl"),
                    (ALT, "Alt"),
                    (SHIFT, "Shift"),
                    (META, "Super"),
                    (KEYPAD, "Numpad"),
                ] {
                    if key & mask != 0 {
                        parts.push(name.to_string());
                    }
                }
                parts.push(keyboard_name(key & !MODIFIERS).unwrap_or_else(|| "Unknown key".into()));
                parts.join("+")
            }
        }
    }

    pub fn mouse_config_key(&self) -> Option<String> {
        match self {
            Self::Mouse { button: 2 } => Some("MiddleButton".into()),
            Self::Mouse { button } if (8..=31).contains(button) => {
                Some(format!("ExtraButton{}", button - 7))
            }
            _ => None,
        }
    }
}

fn keyboard_name(key: i32) -> Option<String> {
    let special = match key {
        0x01000001 => "Tab",
        0x01000002 => "Backtab",
        0x01000003 => "Backspace",
        0x01000004 => "Return",
        0x01000005 => "Enter",
        0x01000006 => "Insert",
        0x01000007 => "Delete",
        0x01000008 => "Pause",
        0x01000009 => "Print",
        0x0100000a => "SysReq",
        0x0100000b => "Clear",
        0x01000010 => "Home",
        0x01000011 => "End",
        0x01000012 => "Left",
        0x01000013 => "Up",
        0x01000014 => "Right",
        0x01000015 => "Down",
        0x01000016 => "Page Up",
        0x01000017 => "Page Down",
        0x01000020 => "Shift",
        0x01000021 => "Ctrl",
        0x01000022 => "Super",
        0x01000023 => "Alt",
        0x01000024 => "Caps Lock",
        0x01000025 => "Num Lock",
        0x01000026 => "Scroll Lock",
        0x01000055 => "Menu",
        0x01000058 => "Help",
        0x01000070 => "Volume down",
        0x01000071 => "Mute",
        0x01000072 => "Volume up",
        0x01000080 => "Play",
        0x01000081 => "Stop",
        0x01000082 => "Previous track",
        0x01000083 => "Next track",
        0x20 => "Space",
        0x01000030..=0x01000052 => return Some(format!("F{}", key - 0x01000030 + 1)),
        _ => {
            return char::from_u32(key as u32)
                .filter(|c| !c.is_control() && !c.is_whitespace())
                .map(|c| c.to_string())
        }
    };
    Some(special.into())
}

/// Translate GTK key symbols into Qt's stable shortcut representation, without changing layout.
pub fn from_gdk(value: gdk::keys::Key, state: gdk::ModifierType) -> Option<Trigger> {
    let symbol = *value;
    let key = match symbol {
        0xff09 => 0x01000001,
        0xfe20 => 0x01000002,
        0xff08 => 0x01000003,
        0xff0d => 0x01000004,
        0xff8d => 0x01000005,
        0xff63 => 0x01000006,
        0xffff => 0x01000007,
        0xff13 => 0x01000008,
        0xff61 => 0x01000009,
        0xff15 => 0x0100000a,
        0xff0b => 0x0100000b,
        0xff50 => 0x01000010,
        0xff57 => 0x01000011,
        0xff51 => 0x01000012,
        0xff52 => 0x01000013,
        0xff53 => 0x01000014,
        0xff54 => 0x01000015,
        0xff55 => 0x01000016,
        0xff56 => 0x01000017,
        0xffe1 | 0xffe2 => 0x01000020,
        0xffe3 | 0xffe4 => 0x01000021,
        0xffe7 | 0xffe8 | 0xffeb | 0xffec => 0x01000022,
        0xffe9 | 0xffea => 0x01000023,
        0xffe5 => 0x01000024,
        0xff7f => 0x01000025,
        0xff14 => 0x01000026,
        0xff67 => 0x01000055,
        0xff6a => 0x01000058,
        0xffbe..=0xffe0 => 0x01000030 + (symbol - 0xffbe) as i32,
        0x1008ff11 => 0x01000070,
        0x1008ff12 => 0x01000071,
        0x1008ff13 => 0x01000072,
        0x1008ff14 => 0x01000080,
        0x1008ff15 => 0x01000081,
        0x1008ff16 => 0x01000082,
        0x1008ff17 => 0x01000083,
        _ => {
            let character = value.to_unicode()?;
            let mut uppercase = character.to_uppercase();
            let first = uppercase.next()?;
            if uppercase.next().is_some() {
                character as i32
            } else {
                first as i32
            }
        }
    };
    let mut modifiers = 0;
    for (gtk, qt) in [
        (gdk::ModifierType::SHIFT_MASK, SHIFT),
        (gdk::ModifierType::CONTROL_MASK, CONTROL),
        (gdk::ModifierType::MOD1_MASK, ALT),
        (gdk::ModifierType::SUPER_MASK, META),
        (gdk::ModifierType::META_MASK, META),
    ] {
        if state.contains(gtk) {
            modifiers |= qt;
        }
    }
    // Modifier-only shortcuts are represented by their key, not Ctrl+Ctrl, etc.
    modifiers &= !match key {
        0x01000020 => SHIFT,
        0x01000021 => CONTROL,
        0x01000022 => META,
        0x01000023 => ALT,
        _ => 0,
    };
    if (0xff80..=0xffbd).contains(&symbol) {
        modifiers |= KEYPAD;
    }
    let trigger = Trigger::Key {
        key: key | modifiers,
    };
    trigger.validate().ok()?;
    Some(trigger)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_keys_modifiers_and_extra_buttons_do_not_require_control() {
        assert_eq!(
            from_gdk(gdk::keys::constants::F8, gdk::ModifierType::empty()),
            Some(Trigger::Key { key: 0x01000037 })
        );
        assert_eq!(
            from_gdk(gdk::keys::constants::v, gdk::ModifierType::empty()),
            Some(Trigger::Key { key: b'V' as i32 })
        );
        assert_eq!(
            from_gdk(
                gdk::keys::constants::Control_R,
                gdk::ModifierType::CONTROL_MASK
            ),
            Some(Trigger::Key { key: 0x01000021 })
        );
        assert!(Trigger::Mouse { button: 8 }.validate().is_ok());
        assert_eq!(
            Trigger::Mouse { button: 31 }.mouse_config_key().as_deref(),
            Some("ExtraButton24")
        );
        assert!(Trigger::Mouse { button: 1 }.validate().is_err());
        assert!(Trigger::Mouse { button: 3 }.validate().is_err());
        assert!(Trigger::Mouse { button: 4 }.validate().is_err());
    }
    #[test]
    fn invalid_saved_triggers_are_rejected() {
        for key in [-1, 0, 10, 0x7fffffff, 0x01000000, 0x01000100] {
            assert!(Trigger::Key { key }.validate().is_err(), "{key}");
        }
        assert!(serde_json::from_str::<Trigger>(
            r#"{"kind":"mouse","button":8,"command":"ignored"}"#
        )
        .is_err());
    }
}
