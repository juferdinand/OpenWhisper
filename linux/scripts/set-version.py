"""Synchronize the project version without downloading or resolving dependencies."""
import json
from pathlib import Path
import re
import sys

version = sys.argv[1]
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
    raise SystemExit("Version must use X.Y.Z format")
root = Path(__file__).resolve().parents[2]
(root / "VERSION").write_text(version + "\n")
for name in ["shared/ui/package.json", "shared/ui/package-lock.json", "linux/package.json", "linux/package-lock.json", "linux/src-tauri/tauri.conf.json"]:
    path = root / name
    data = json.loads(path.read_text())
    data["version"] = version
    if name.endswith("package-lock.json"):
        data["packages"][""]["version"] = version
    path.write_text(json.dumps(data, indent=2) + "\n")
path = root / "linux/Cargo.toml"
path.write_text(re.sub(r'(?m)^version = "[^"]+"', f'version = "{version}"', path.read_text(), count=1))
path = root / "linux/Cargo.lock"
path.write_text(re.sub(r'(name = "openwhisper-(?:core|speech|desktop)"\nversion = ")[^"]+("\n)', rf'\g<1>{version}\2', path.read_text()))
