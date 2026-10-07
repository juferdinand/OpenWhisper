#!/usr/bin/env python3
"""Run the actual local installer with inert payloads in disposable private homes."""
import hashlib
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "linux/scripts/install-local.sh"


class LocalInstallerTests(unittest.TestCase):
    def install_and_check(self, appimage):
        with tempfile.TemporaryDirectory(prefix="openwhisper-local-install-") as temporary:
            private = Path(temporary)
            source = private / "source root [owned]"
            linux = source / "linux"
            script = linux / "scripts/install-local.sh"
            script.parent.mkdir(parents=True)
            shutil.copyfile(SCRIPT, script)
            resources = ["LICENSE", "linux/THIRD_PARTY_NOTICES.md",
                         "shared/ui/public/fonts/LICENSE.txt", "linux/src-tauri/icons/icon.png"]
            for relative in resources:
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            shutil.copytree(ROOT / "linux/licenses", linux / "licenses")
            special = linux / "licenses/deep path [owned]/subdirectory/file\nname.txt"
            special.parent.mkdir(parents=True)
            special.write_bytes(b"Owned nested license filename fixture.\n")
            special.chmod(0o751)
            self.assertTrue((linux / "licenses/gtk-layer-shell/LICENSE_LGPL.txt").is_file())
            payload = (private / "owned candidate.AppImage" if appimage
                       else linux / "target/release/openwhisper-desktop")
            payload.parent.mkdir(parents=True, exist_ok=True)
            # Copying is exercised; neither candidate is executed or opens devices.
            payload.write_bytes(b"Owned inert local installer payload; never executed.\n")
            home = private / "user home"
            config, data, cache, runtime = [private / name for name in ["config", "data", "cache", "runtime"]]
            for path in [home, config, data, cache, runtime]:
                path.mkdir(mode=0o700)
            settings = config / "whisperfree/settings.json"
            settings.parent.mkdir()
            settings.write_bytes(b'{"ui_language":"de","setup_completed":true}\n')
            model = data / "whisperfree/models/owned-sentinel.bin"
            model.parent.mkdir(parents=True)
            model.write_bytes(b"Owned non-model data; never loaded.\n")
            preserved = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in [settings, model]}
            commands = private / "commands"
            commands.mkdir()
            # These host-dependent cache refreshes must not contact a real desktop.
            for name in ["update-desktop-database", "gtk-update-icon-cache", "kbuildsycoca6"]:
                stub = commands / name
                stub.write_text("#!/bin/sh\nexit 0\n")
                stub.chmod(0o755)
            environment = {"HOME": str(home), "XDG_CONFIG_HOME": str(config),
                           "XDG_DATA_HOME": str(data), "XDG_CACHE_HOME": str(cache),
                           "XDG_RUNTIME_DIR": str(runtime), "LC_ALL": "C.UTF-8",
                           "PATH": str(commands) + ":/usr/bin:/bin"}
            command = ["bash", str(script)]
            if appimage:
                command += ["--appimage", str(payload)]
            for attempt in range(2):
                result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                installed = home / ".local/lib/whisperfree"
                target_name = "OpenWhisper.AppImage" if appimage else "openwhisper-desktop"
                self.assertEqual((installed / target_name).read_bytes(), payload.read_bytes())
                self.assertEqual(stat.S_IMODE((installed / target_name).stat().st_mode), 0o755)
                for original in (linux / "licenses").rglob("*"):
                    if original.is_file():
                        relative = original.relative_to(linux / "licenses")
                        target = installed / "licenses" / relative
                        self.assertTrue(target.is_file() and not target.is_symlink(), str(relative))
                        self.assertEqual(target.read_bytes(), original.read_bytes(), str(relative))
                        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644, str(relative))
                for relative, name in [("LICENSE", "LICENSE"),
                                       ("linux/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
                                       ("shared/ui/public/fonts/LICENSE.txt", "Inter-LICENSE.txt")]:
                    self.assertEqual((installed / name).read_bytes(), (source / relative).read_bytes())
                desktop = (data / "applications/io.github.whisperfree.desktop").read_text()
                self.assertIn(str(installed / target_name), desktop)
                self.assertIn("StartupWMClass=io.github.whisperfree", desktop)
                self.assertEqual("APPIMAGE_EXTRACT_AND_RUN=1" in desktop, appimage)
                self.assertEqual((data / "icons/hicolor/256x256/apps/io.github.whisperfree.png").read_bytes(),
                                 (source / "linux/src-tauri/icons/icon.png").read_bytes())
                for path, digest in preserved.items():
                    self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
                if attempt == 0:
                    # Reinstallation must repair the nested notice's bytes/mode.
                    target = installed / "licenses/gtk-layer-shell/LICENSE_LGPL.txt"
                    target.write_bytes(b"Owned stale installation fixture.\n")
                    target.chmod(0o600)

    def test_native_install_preserves_nested_notices_and_user_data(self):
        self.install_and_check(appimage=False)

    def test_appimage_install_preserves_nested_notices_and_user_data(self):
        self.install_and_check(appimage=True)


if __name__ == "__main__":
    unittest.main()
