"""Keep Linux branding and the six settings tabs aligned with the native Mac app."""
from pathlib import Path
import json
import re
import struct

root = Path(__file__).resolve().parents[2]
icon = (root / "macos/Resources/AppIcon.icns").read_bytes()
offset = 8
while offset < len(icon):
    kind = icon[offset:offset + 4]
    size = struct.unpack(">I", icon[offset + 4:offset + 8])[0]
    if kind == b"ic08":
        png = icon[offset + 8:offset + size]
        assert (root / "desktop/public/app-icon.png").read_bytes() == png, "Frontend icon differs from macOS"
        assert (root / "desktop/src-tauri/icons/icon.png").read_bytes() == png, "Package icon differs from macOS"
        break
    offset += size
else:
    raise AssertionError("macOS 256px icon missing")

swift = (root / "macos/Sources/WhisperFree/UI/SettingsWindow.swift").read_text()
tabs = re.search(r"case (setup, general, models, snippets, history, about)", swift).group(1).split(", ")
frontend = (root / "desktop/src/main.ts").read_text()
positions = [re.search(r'\[\s*"' + tab + r'"\s*,', frontend).start() for tab in tabs]
assert positions == sorted(positions), "Settings tabs must follow the macOS order"
version = (root / "VERSION").read_text().strip()
for file in ["desktop/package.json", "desktop/src-tauri/tauri.conf.json"]:
    assert json.loads((root / file).read_text())["version"] == version, f"Version mismatch: {file}"
pin = json.loads((root / "desktop/native/whisper-source.json").read_text())
assert f'VERSION="{pin["tag"]}"' in (root / "macos/scripts/fetch-whisper.sh").read_text(), "Native versions must match"
print("macOS/Linux icons, settings order, versions, and speech source tag match.")
