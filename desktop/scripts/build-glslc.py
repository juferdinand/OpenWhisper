#!/usr/bin/env python3
"""Build a pinned shader compiler on distributions without a recent glslc package."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

root = Path(__file__).resolve().parents[1]
pins = json.loads((root / "native/shaderc-source.json").read_text())
prefix = root / "vendor/shaderc"
marker = prefix / ".source-pins"
compiler = prefix / "bin/glslc"
encoded = json.dumps(pins, sort_keys=True)
if compiler.is_file() and marker.is_file() and marker.read_text() == encoded:
    print(compiler)
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="openwhisper-shaderc-") as temporary:
    folder = Path(temporary)
    source = folder / "source"
    for name, pin in pins.items():
        archive = folder / f"{name}.tar.gz"
        url = f'https://codeload.github.com/{pin["repository"]}/tar.gz/{pin["revision"]}'
        urllib.request.urlretrieve(url, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
            raise SystemExit(f"Checksum mismatch for {name}")
        extracted = folder / name
        with tarfile.open(archive) as package:
            for item in package.getmembers():
                if (not (item.isfile() or item.isdir()) or Path(item.name).is_absolute()
                        or ".." in Path(item.name).parts):
                    raise SystemExit("Unsafe compiler archive member")
            package.extractall(extracted)
        destination = source if name == "shaderc" else source / "third_party" / name
        shutil.copytree(next(extracted.iterdir()), destination, dirs_exist_ok=True)
    build = folder / "build"
    subprocess.run(["cmake", "-S", str(source), "-B", str(build), "-G", "Ninja",
                    "-DCMAKE_BUILD_TYPE=Release", "-DSHADERC_SKIP_TESTS=ON",
                    "-DSHADERC_SKIP_EXAMPLES=ON",
                    "-DSHADERC_SKIP_COPYRIGHT_CHECK=ON", "-DSHADERC_ENABLE_WERROR_COMPILE=OFF",
                    "-DBUILD_SHARED_LIBS=OFF"], check=True)
    subprocess.run(["cmake", "--build", str(build), "--target", "glslc_exe", "--parallel",
                    str(min(os.cpu_count() or 2, 4))], check=True)
    compiler.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(build / "glslc/glslc", compiler)
    subprocess.run([str(compiler), "--version"], check=True)
    marker.write_text(encoded)
print(compiler)
