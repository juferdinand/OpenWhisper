use gtk::gdk;
use serde::{Deserialize, Serialize};

/// A captured X11 hardware key, verified against the current group before binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub keycode: u32,
    pub keysym: u32,
    pub modifiers: u32,
    pub group: u32,
}

impl Trigger {
    pub fn validate(&self) -> Result<(), String> {
        if !(8..=255).contains(&self.keycode)
            || self.modifiers > 255
            || self.group > 3
            || !supported_symbol(self.keysym)
        {
            return Err("Choose a regular keyboard key or shortcut for the X11 trigger.".into());
        }
        Ok(())
    }

    pub fn label(&self) -> String {
        let mut parts = Vec::new();
        for (mask, name) in [(4, "Ctrl"), (8, "Alt"), (1, "Shift"), (64, "Super")] {
            if self.modifiers & mask != 0 {
                parts.push(name.to_owned());
            }
        }
        for bit in [16, 32, 128] {
            if self.modifiers & bit != 0 {
                parts.push(format!("Mod{}", bit.trailing_zeros() - 2));
            }
        }
        let value = gdk::keys::Key::from(self.keysym);
        let name = value
            .to_unicode()
            .filter(|c| !c.is_control() && !c.is_whitespace())
            .map(|c| c.to_uppercase().to_string())
            .or_else(|| value.name().map(|s| s.to_string()))
            .unwrap_or_else(|| "Unknown key".into());
        parts.push(if name == "space" {
            "Space".into()
        } else {
            name
        });
        parts.join("+")
    }
}

fn supported_symbol(symbol: u32) -> bool {
    if symbol == 0
        || symbol == 0xff1b
        || symbol > 0x1fff_ffff
        || (0xffe1..=0xffee).contains(&symbol)
        || [0xff7f, 0xff14, 0xfe03, 0xfe11].contains(&symbol)
    {
        return false;
    }
    let key = gdk::keys::Key::from(symbol);
    key.name().is_some() && key.to_unicode().is_none_or(|c| !c.is_control())
}

pub fn from_event(event: &gdk::EventKey) -> Option<Trigger> {
    let trigger = Trigger {
        keycode: event.hardware_keycode().into(),
        keysym: *event.keyval().to_lower(),
        // Core X11 modifier bits only. Lock variants are resolved by the helper.
        modifiers: event.state().bits() & 255 & !2,
        group: event.group().into(),
    };
    trigger.validate().ok()?;
    Some(trigger)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x11_profiles_reject_unsafe_keys_and_unknown_fields() {
        let valid = Trigger {
            keycode: 74,
            keysym: 0xffc5,
            modifiers: 4 | 8,
            group: 0,
        };
        assert!(valid.validate().is_ok());
        assert_eq!(valid.label(), "Ctrl+Alt+F8");
        for keysym in [
            0,
            0xff1b,
            0xffe1,
            0xffe3,
            0xffe5,
            0xff7f,
            0xfe03,
            0xffff_ffff,
        ] {
            assert!(Trigger {
                keysym,
                ..valid.clone()
            }
            .validate()
            .is_err());
        }
        for keycode in [0, 7, 256, u32::MAX] {
            assert!(Trigger {
                keycode,
                ..valid.clone()
            }
            .validate()
            .is_err());
        }
        assert!(Trigger {
            modifiers: 256,
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(Trigger {
            group: 4,
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(serde_json::from_str::<Trigger>(
            r#"{"keycode":74,"keysym":65477,"modifiers":12,"group":0,"command":"ignored"}"#
        )
        .is_err());
    }
}
