#!/usr/bin/env python3
"""Passively verify optional-overlay files in the actual AppImage SquashFS."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location("prepare_appimage", Path(__file__).with_name("prepare-appimage.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def squashfs_offset(data):
    candidates = []
    offset = data.find(b"hsqs")
    while offset != -1:
        if offset + 96 <= len(data):
            block_size = struct.unpack_from("<I", data, offset + 12)[0]
            block_log = struct.unpack_from("<H", data, offset + 22)[0]
            version = struct.unpack_from("<HH", data, offset + 28)
            used = struct.unpack_from("<Q", data, offset + 40)[0]
            if version == (4, 0) and 12 <= block_log <= 20 and block_size == 1 << block_log and 96 <= used <= len(data) - offset:
                candidates.append(offset)
        offset = data.find(b"hsqs", offset + 4)
    if len(candidates) != 1:
        raise RuntimeError("Expected one valid SquashFS v4 image")
    return candidates[0]


def elf_details(path):
    if not prepare.compatible_elf(path):
        raise RuntimeError("Bundled overlay library is not a compatible native shared ELF")
    dynamic = subprocess.check_output(["readelf", "-d", str(path)], text=True)
    if not re.search(r"\(SONAME\).*\[" + re.escape(prepare.SONAME) + r"\]", dynamic):
        raise RuntimeError("Bundled overlay library has the wrong SONAME")
    symbols = subprocess.check_output(["readelf", "--dyn-syms", "--wide", str(path)], text=True)
    required = {"gtk_layer_init_for_window", "gtk_layer_is_supported", "gtk_layer_set_keyboard_mode",
                "gtk_layer_set_layer", "gtk_layer_set_anchor", "gtk_layer_set_margin"}
    exports = {fields[7].split("@")[0] for line in symbols.splitlines()
               if len(fields := line.split()) >= 8 and fields[6] != "UND"}
    if not required <= exports:
        raise RuntimeError("Bundled overlay library lacks required GTK layer-shell functions")
    notes = subprocess.check_output(["readelf", "-n", str(path)], text=True)
    match = re.search(r"Build ID: ([0-9a-f]+)", notes)
    if not match:
        raise RuntimeError("Overlay library has no build ID for packaging provenance")
    return match[1]


def verify(package):
    data = package.read_bytes()
    offset = squashfs_offset(data)
    staged = prepare.OUTPUT
    expected = json.loads((staged / "build-origin.json").read_text())
    with tempfile.TemporaryDirectory(prefix="openwhisper-appimage-files-") as temporary:
        extracted = Path(temporary) / "image"
        command = ["unsquashfs", "-no-progress", "-processors", "1", "-offset", str(offset),
                   "-d", str(extracted), str(package.resolve()),
                   "usr/lib/" + prepare.SONAME, "usr/share/doc/gtk-layer-shell"]
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        library = extracted / "usr/lib" / prepare.SONAME
        if not library.is_file() or library.is_symlink() or not library.resolve().is_relative_to(extracted):
            raise RuntimeError("Actual AppImage omits its gtk-layer-shell runtime")
        build_id = elf_details(library)
        if build_id != elf_details(staged / prepare.SONAME):
            raise RuntimeError("AppImage overlay library differs from the staged build-system library")
        for name in ["copyright", "LICENSE_GPL.txt", "LICENSE_LGPL.txt", "LICENSE_MIT.txt", "build-origin.json"]:
            target = extracted / "usr/share/doc/gtk-layer-shell" / name
            if (not target.is_file() or target.is_symlink() or not target.resolve().is_relative_to(extracted)
                    or target.read_bytes() != (staged / name).read_bytes()):
                raise RuntimeError("Actual AppImage omits or changes gtk-layer-shell notice: " + name)
        return {"package": package.name, "package_sha256": hashlib.sha256(data).hexdigest(),
                "squashfs_offset": offset, "library_sha256": hashlib.sha256(library.read_bytes()).hexdigest(),
                "library_build_id": build_id, "staged_library_sha256": expected["sha256"][prepare.SONAME],
                "copyright_origin": expected["copyright_origin"], "status": "PASS"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+", type=Path)
    args = parser.parse_args()
    for package in args.packages:
        print(json.dumps(verify(package), sort_keys=True))


if __name__ == "__main__":
    main()
