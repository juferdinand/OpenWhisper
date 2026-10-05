#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$ROOT/target/release/whisperfree-desktop"
[[ -x "$BINARY" ]] || { echo "Build first with make linux." >&2; exit 1; }
DEST="$HOME/.local/lib/whisperfree"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
install -Dm755 "$BINARY" "$DEST/whisperfree-desktop"
install -Dm644 "$ROOT/../LICENSE" "$DEST/LICENSE"
install -Dm644 "$ROOT/THIRD_PARTY_NOTICES.md" "$DEST/THIRD_PARTY_NOTICES.md"
install -Dm644 "$ROOT/src-tauri/icons/icon.png" "$DATA/icons/hicolor/256x256/apps/io.github.whisperfree.png"
python3 - "$DEST/whisperfree-desktop" "$DATA/applications/io.github.whisperfree.desktop" <<'PY'
from pathlib import Path
import sys
binary = sys.argv[1]
# Desktop Entry Exec escaping, including percent field codes.
escaped = binary.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
entry = Path(sys.argv[2])
entry.parent.mkdir(parents=True, exist_ok=True)
entry.write_text('[Desktop Entry]\nType=Application\nName=WhisperFree\nComment=Free, local dictation\n'
                 f'Exec="{escaped}"\nIcon=io.github.whisperfree\nTerminal=false\nCategories=Utility;Audio;\n')
PY
if command -v update-desktop-database >/dev/null; then update-desktop-database "$DATA/applications"; fi
echo "Installed for this user. Open WhisperFree from the application launcher."
echo "Models and settings are kept separately in your XDG data and configuration directories."
