#!/usr/bin/env python3
"""Stage the dlopen-only overlay library and its notices for Tauri AppImage files.

Native builds keep gtk-layer-shell optional. AppImage packaging must include it
explicitly because the ELF dependency scanner cannot discover a dlopen request.
"""
import hashlib
import json
import platform
from pathlib import Path
import re
import shutil
import struct
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SONAME = "libgtk-layer-shell.so.0"
OUTPUT = ROOT / "target/appimage-extra"
ARCHITECTURES = {"x86_64": (2, 62), "aarch64": (2, 183), "i686": (1, 3), "armv7l": (1, 40)}


def compatible_elf(path):
    header = path.read_bytes()[:20]
    expected = ARCHITECTURES.get(platform.machine())
    return (expected is not None and len(header) == 20 and header[:4] == b"\x7fELF"
            and header[4] == expected[0] and header[5] == 1
            and struct.unpack_from("<HH", header, 16) == (3, expected[1]))


def library_path():
    command = shutil.which("ldconfig") or "/sbin/ldconfig"
    cache = subprocess.check_output([command, "-p"], text=True)
    for line in cache.splitlines():
        match = re.match(r"\s*" + re.escape(SONAME) + r"\s+.*=>\s+(\S+)\s*$", line)
        if match:
            path = Path(match[1]).resolve(strict=True)
            if compatible_elf(path):
                return path
    raise RuntimeError("Install the native gtk-layer-shell runtime before AppImage packaging")


def debian_owners(path):
    result = subprocess.run(["dpkg-query", "-S", str(path)], text=True, capture_output=True)
    return {owner.strip() for line in result.stdout.splitlines() if ": " in line
            for owner in line.split(": ", 1)[0].split(",")} if result.returncode == 0 else set()


def notice_source(library, version):
    if not version:
        raise RuntimeError("Cannot establish the installed overlay library version")
    if shutil.which("dpkg-query"):
        aliases = [library]
        if str(library).startswith("/usr/lib/"):
            aliases.append(Path(str(library).removeprefix("/usr")))
        elif str(library).startswith("/lib/"):
            aliases.append(Path("/usr" + str(library)))
        owners = set()
        for alias in aliases:
            if alias.is_file() and alias.resolve() == library:
                owners.update(debian_owners(alias))
        packages = sorted(owner for owner in owners if owner.split(":")[0] == "libgtk-layer-shell0")
        if not packages:
            raise RuntimeError("Selected overlay library is not owned by the installed Debian runtime package")
        package = packages[0]
        package_version = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", package], text=True).strip()
        notice = Path("/usr/share/doc/libgtk-layer-shell0/copyright")
        if not notice.is_file() or package not in debian_owners(notice):
            raise RuntimeError("Overlay library and Debian copyright do not have the same package owner")
        origin = "installed distribution copyright"
    elif shutil.which("pacman"):
        result = subprocess.run(["pacman", "-Qoq", str(library)], text=True, capture_output=True)
        package = result.stdout.strip() if result.returncode == 0 else None
        if package != "gtk-layer-shell":
            raise RuntimeError("Selected overlay library is not owned by the installed Arch runtime package")
        package_version = subprocess.check_output(["pacman", "-Q", package], text=True).split()[1]
        if version != "0.10.1":
            raise RuntimeError("Update the upstream copyright snapshot for the installed Arch runtime version")
        notice = ROOT / "licenses/gtk-layer-shell/copyright-0.10.1.txt"
        origin = "matching upstream 0.10.1 source notices"
    else:
        raise RuntimeError("AppImage overlay notice provenance requires a Debian or Arch runtime package")
    if not re.match(r"^(?:\d+:)?" + re.escape(version) + r"(?:[-+~]|$)", package_version):
        raise RuntimeError("Selected overlay library version does not match its package owner")
    return notice, origin, package, package_version


def arch_protocol_notices():
    """Retain installed protocol notices absent from Arch's library package.

    These are notice inputs from the installed wayland-protocols package, not
    an assertion about the binary package's historical build dependencies.
    The library's pinned upstream Meson manifest includes both protocols.
    """
    paths = [Path("/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml"),
             Path("/usr/share/wayland-protocols/staging/ext-session-lock/ext-session-lock-v1.xml")]
    notices, inputs = [], []
    for path in paths:
        owner = subprocess.check_output(["pacman", "-Qoq", str(path)], text=True).strip()
        if owner != "wayland-protocols":
            raise RuntimeError("External overlay protocol notice is not owned by wayland-protocols")
        version = subprocess.check_output(["pacman", "-Q", owner], text=True).split()[1]
        data = path.read_bytes()
        copyright_text = ET.fromstring(data).findtext("copyright")
        if not copyright_text or not copyright_text.strip():
            raise RuntimeError("External overlay protocol has no copyright notice")
        notices.append("\nInstalled external protocol notice: " + str(path) + "\n"
                       + "Package: " + owner + " " + version + "\n\n" + copyright_text + "\n")
        inputs.append({"path": str(path), "package_owner": owner, "package_version": version,
                       "sha256": hashlib.sha256(data).hexdigest()})
    return "".join(notices).encode(), inputs


def main():
    library = library_path()
    match = re.fullmatch(r"libgtk-layer-shell\.so\.(\d+\.\d+\.\d+)", library.name)
    # Distribution libraries use the upstream version for their real filename,
    # e.g. libgtk-layer-shell.so.0.6.0 and libgtk-layer-shell.so.0.10.1.
    version = match[1] if match else None
    copyright_file, origin, package, package_version = notice_source(library, version)
    license_root = ROOT / "licenses/gtk-layer-shell"
    files = {SONAME: library, "copyright": copyright_file}
    files.update({name: license_root / name for name in ["LICENSE_GPL.txt", "LICENSE_LGPL.txt", "LICENSE_MIT.txt"]})
    # Validate all inputs before overwriting a previous staging set.
    contents = {name: path.read_bytes() for name, path in files.items()}
    protocol_inputs = []
    if package == "gtk-layer-shell":
        protocol_notices, protocol_inputs = arch_protocol_notices()
        contents["copyright"] += protocol_notices
    if any(not data for data in contents.values()):
        raise RuntimeError("gtk-layer-shell library or license input is empty")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, data in contents.items():
        target = OUTPUT / name
        target.write_bytes(data)
        target.chmod(0o644)
    manifest = {"soname": SONAME, "version": version, "architecture": platform.machine(),
                "library_source": str(library), "copyright_source": str(copyright_file.relative_to(ROOT))
                if copyright_file.is_relative_to(ROOT) else str(copyright_file), "copyright_origin": origin,
                "package_owner": package, "package_version": package_version,
                "external_protocol_notice_inputs": protocol_inputs,
                "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}}
    (OUTPUT / "build-origin.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Staged gtk-layer-shell runtime and matching notices for AppImage packaging")


if __name__ == "__main__":
    main()
