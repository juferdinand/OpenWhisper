#!/usr/bin/env python3
"""Install pinned Khronos headers for reproducible Vulkan builds on older distributions."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

root = Path(__file__).resolve().parents[1]
pins = json.loads((root / "native/vulkan-headers.json").read_text())
prefix = root / "vendor/vulkan"
marker = prefix / ".source-pins"
encoded = json.dumps(pins, sort_keys=True)
if marker.exists() and marker.read_text() == encoded:
    print(prefix)
    raise SystemExit(0)
for name, pin in pins.items():
    with tempfile.TemporaryDirectory(prefix="openwhisper-vulkan-") as temporary:
        folder = Path(temporary)
        archive = folder / "source.tar.gz"
        url = f'https://codeload.github.com/KhronosGroup/{name}/tar.gz/{pin["revision"]}'
        urllib.request.urlretrieve(url, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
            raise SystemExit(f"Checksum mismatch for {name}")
        with tarfile.open(archive) as source:
            # Archives come from pinned upstream commits; reject traversal and links explicitly.
            for item in source.getmembers():
                if Path(item.name).is_absolute() or ".." in Path(item.name).parts or item.issym() or item.islnk():
                    raise SystemExit("Unsafe header archive member")
            source.extractall(folder / "source")
        directory = next((folder / "source").iterdir())
        subprocess.run(["cmake", "-S", str(directory), "-B", str(folder / "build"),
                        f"-DCMAKE_INSTALL_PREFIX={prefix}", "-DBUILD_TESTING=OFF"], check=True)
        subprocess.run(["cmake", "--install", str(folder / "build")], check=True)
prefix.mkdir(parents=True, exist_ok=True)
marker.write_text(encoded)
print(prefix)
