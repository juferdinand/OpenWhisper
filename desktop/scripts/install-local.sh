#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$ROOT/target/release/whisperfree-desktop"
APPIMAGE_MODE=0
if [[ "${1:-}" == "--appimage" && $# -eq 2 ]]; then
    BINARY="$(realpath "$2")"
    APPIMAGE_MODE=1
elif [[ $# -ne 0 ]]; then
    echo "Usage: $0 [--appimage /path/to/WhisperFree-Linux-x86_64.AppImage]" >&2
    exit 1
fi
[[ -f "$BINARY" ]] || { echo "Build first with make linux, or supply a release AppImage." >&2; exit 1; }
DEST="$HOME/.local/lib/whisperfree"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
TARGET="$DEST/whisperfree-desktop"
if [[ "$APPIMAGE_MODE" == 1 ]]; then TARGET="$DEST/WhisperFree.AppImage"; fi
install -Dm755 "$BINARY" "$TARGET"
install -Dm644 "$ROOT/../LICENSE" "$DEST/LICENSE"
install -Dm644 "$ROOT/THIRD_PARTY_NOTICES.md" "$DEST/THIRD_PARTY_NOTICES.md"
install -Dm644 "$ROOT/public/fonts/LICENSE.txt" "$DEST/Inter-LICENSE.txt"
install -Dm644 "$ROOT/src-tauri/icons/icon.png" "$DATA/icons/hicolor/256x256/apps/io.github.whisperfree.png"
python3 - "$TARGET" "$DATA/applications/io.github.whisperfree.desktop" "$APPIMAGE_MODE" <<'PY'
from pathlib import Path
import sys
binary = sys.argv[1]
# Desktop Entry Exec escaping, including percent field codes.
escaped = binary.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
prefix = 'env APPIMAGE_EXTRACT_AND_RUN=1 ' if sys.argv[3] == '1' else ''
entry = Path(sys.argv[2])
entry.parent.mkdir(parents=True, exist_ok=True)
entry.write_text('[Desktop Entry]\nType=Application\nName=WhisperFree\nComment=Free, local dictation\n'
                 f'Exec={prefix}"{escaped}"\nIcon=io.github.whisperfree\nStartupWMClass=io.github.whisperfree\nStartupNotify=true\nTerminal=false\nCategories=Utility;Audio;\n')
PY
if command -v update-desktop-database >/dev/null; then update-desktop-database "$DATA/applications"; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "$DATA/icons/hicolor" >/dev/null 2>&1 || true; fi
if command -v kbuildsycoca6 >/dev/null; then kbuildsycoca6 --noincremental >/dev/null 2>&1; fi
echo "Installed for this user. Open WhisperFree from the application launcher."
echo "Models and settings are kept separately in your XDG data and configuration directories."
