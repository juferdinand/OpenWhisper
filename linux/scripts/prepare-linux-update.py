#!/usr/bin/env python3
"""Prepare signed Linux downloads and the updater feed from this build's packages."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
linux = root / "linux"
version = (root / "VERSION").read_text().strip()
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
    raise SystemExit("Invalid release version")
if not os.environ.get("TAURI_SIGNING_PRIVATE_KEY"):
    raise SystemExit("TAURI_SIGNING_PRIVATE_KEY is required for release packages")
bundle = linux / "target/release/bundle"
output = bundle / "release"
output.mkdir(exist_ok=True)
verifier = linux / "target/debug/examples/verify-update"
if not verifier.is_file():
    raise SystemExit("Build the release verifier with cargo build --locked -p openwhisper-core --example verify-update")
platforms = {}
assets = []
for folder, extension, asset, target in [
    ("appimage", "AppImage", "OpenWhisper-Linux-x86_64.AppImage", "linux-x86_64-appimage"),
    ("deb", "deb", "OpenWhisper-Linux-amd64.deb", "linux-x86_64-deb"),
]:
    package = output / asset
    shutil.copy2(bundle / folder / f"OpenWhisper_{version}_amd64.{extension}", package)
    result = subprocess.run(
        [str(linux / "node_modules/.bin/tauri"), "signer", "sign", "--app-version", version, str(package)],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise SystemExit("Signing failed. Check the configured Linux signing identity and password.")
    signature = Path(str(package) + ".sig")
    subprocess.run([str(verifier), str(linux / "src-tauri/tauri.conf.json"), str(package), str(signature), version], check=True)
    platforms[target] = {
        "url": f"https://github.com/juferdinand/OpenWhisper/releases/download/v{version}/{asset}",
        "signature": signature.read_text().strip(),
    }
    assets.extend([package, signature])
feed = output / "latest.json"
feed.write_text(json.dumps({
    "version": version,
    "notes": f"OpenWhisper {version}. See the GitHub release for changes and platform notes.",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "platforms": platforms,
}, indent=2) + "\n")
assets.append(feed)
(output / "SHA256SUMS").write_text("".join(
    f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in assets
))
print("Prepared and verified Linux packages, version-bound signatures, and latest.json.")
