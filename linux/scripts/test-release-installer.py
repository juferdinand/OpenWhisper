#!/usr/bin/env python3
"""Test the terminal installer using signed inert packages and disposable homes."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("install-release.py")
spec = importlib.util.spec_from_file_location("release_installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
PINNED_KEY = installer.PUBLIC_KEY


class ReleaseInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("openssl", "mksquashfs", "unsquashfs"):
            if not shutil.which(command):
                raise RuntimeError(f"Test prerequisite missing: {command}")
        cls.directory = tempfile.TemporaryDirectory(prefix="openwhisper-installer-tests-")
        cls.root = Path(cls.directory.name)
        cls.identities = {}
        cls.signatures = 0
        for name in ("trusted", "foreign"):
            secret = cls.root / f"{name}.key"
            public = cls.root / f"{name}.der"
            subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(secret)], check=True, capture_output=True)
            subprocess.run(["openssl", "pkey", "-in", str(secret), "-pubout", "-outform", "DER", "-out", str(public)],
                           check=True, capture_output=True)
            key_id = os.urandom(8)
            framed = b"Ed" + key_id + public.read_bytes()[-32:]
            (cls.root / f"{name}.pub").write_bytes(b"untrusted comment: ephemeral installer test key\n" + base64.b64encode(framed) + b"\n")
            cls.identities[name] = key_id
        cls.public_key = base64.b64encode((cls.root / "trusted.pub").read_bytes()).decode()
        cls.packages = {}
        resources = cls.root / "resources"
        prefix = resources / f"usr/lib/{installer.IDENTITY}"
        (prefix / "licenses").mkdir(parents=True)
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md", "Inter-LICENSE.txt", *[f"licenses/{name}" for name in installer.LICENSES]):
            (prefix / name).write_text(f"Owned inert installer fixture: {name}\n")
        icon = SCRIPT.parents[1] / "src-tauri/icons/icon.png"
        shutil.copyfile(icon, resources / f"{installer.IDENTITY}.png")
        squashfs = cls.root / "data.squashfs"
        subprocess.run(["mksquashfs", str(resources), str(squashfs), "-noappend", "-processors", "1", "-quiet"],
                       check=True, capture_output=True)
        header = bytearray(128)
        header[:6] = b"\x7fELF\x02\x01"
        header[8:11] = b"AI\x02"
        struct.pack_into("<H", header, 18, 62)
        for release in ("0.2.4", "0.2.5", "0.3.0"):
            image = cls.root / f"{release}.AppImage"
            image.write_bytes(header + squashfs.read_bytes())
            cls.packages[release] = (image, cls.sign(image, release))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    @classmethod
    def sign(cls, image, release, identity="trusted", comment=None, legacy=False):
        # Synthetic packages exercise transactions using distro OpenSSL. A committed
        # independently Minisign-generated vector and optional Minisign oracle below
        # prevent this test signer from being the only evidence for the format.
        cls.signatures += 1
        prefix = cls.root / f"signature-{cls.signatures}"
        payload = prefix.with_suffix(".input")
        payload.write_bytes(image.read_bytes() if legacy else hashlib.blake2b(image.read_bytes()).digest())
        detached = prefix.with_suffix(".detached")

        def raw_sign(source):
            subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(cls.root / f"{identity}.key"),
                            "-in", str(source), "-out", str(detached)], check=True, capture_output=True)
            return detached.read_bytes()

        signed = raw_sign(payload)
        trusted = comment if comment is not None else f"timestamp:1\tfile:{installer.asset_name(release)}\tversion:{release}"
        payload.write_bytes(signed + trusted.encode())
        frame = (b"Ed" if legacy else b"ED") + cls.identities[identity] + signed
        text = b"untrusted comment: synthetic installer test signature\n" + base64.b64encode(frame)
        text += b"\ntrusted comment: " + trusted.encode() + b"\n" + base64.b64encode(raw_sign(payload)) + b"\n"
        encoded = prefix.with_suffix(".sig")
        encoded.write_text(base64.b64encode(text).decode())
        return encoded

    def setUp(self):
        self.home_directory = tempfile.TemporaryDirectory(dir=self.root, prefix="home with % $ ` \\\" ")
        self.home = Path(self.home_directory.name)
        self.installation = installer.Installation(self.home, self.home / "data", self.home / "config")
        self.key_patch = patch.object(installer, "PUBLIC_KEY", self.public_key)
        self.key_patch.start()
        self.sentinel = self.home / "data/whisperfree/models/do-not-delete.bin"
        self.sentinel.parent.mkdir(parents=True)
        self.sentinel.write_bytes(b"private user model fixture")

    def tearDown(self):
        self.key_patch.stop()
        self.home_directory.cleanup()

    def install(self, release="0.2.5", image=None, signature=None):
        selected, signed = self.packages[release]
        with self.installation.locked(), tempfile.TemporaryDirectory(dir=self.home) as work:
            installer.install(self.installation, release, Path(work), image or selected, signature or signed)

    def snapshot(self):
        return {str(path.relative_to(self.home)): (path.read_bytes(), path.stat().st_mode & 0o777)
                for path in self.home.rglob("*") if path.is_file() and "transaction" not in path.parts}

    def test_first_install_reinstall_upgrade_and_uninstall_preserve_user_data_and_autostart(self):
        self.install("0.2.4")
        self.assertEqual(self.installation.image.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.installation.image.read_bytes(), self.packages["0.2.4"][0].read_bytes())
        self.assertFalse(self.installation.autostart.exists())
        self.installation.autostart.parent.mkdir(parents=True)
        content = installer.desktop_entry(self.installation.image)
        self.installation.autostart.write_text(content)
        self.install("0.2.4")
        self.install("0.2.5")
        self.assertEqual(self.installation.autostart.read_text(), content)
        self.assertEqual(json.loads(self.installation.manifest.read_text())["version"], "0.2.5")
        with self.installation.locked():
            self.installation.uninstall()
        self.assertFalse(self.installation.image.exists())
        self.assertFalse(self.installation.desktop.exists())
        self.assertFalse(self.installation.icon.exists())
        self.assertFalse(self.installation.autostart.exists())
        self.assertEqual(self.sentinel.read_bytes(), b"private user model fixture")

    def test_tampered_payload_wrong_key_wrong_version_and_unsigned_version_are_rejected(self):
        self.install()
        before = self.snapshot()
        image, signature = self.packages["0.3.0"]
        modified = self.home / "modified.AppImage"
        modified.write_bytes(image.read_bytes() + b"tampered")
        foreign = self.sign(image, "0.3.0", identity="foreign")
        unsigned_version = self.sign(image, "0.3.0", comment="timestamp:1\tfile:OpenWhisper-Linux-x86_64.AppImage")
        duplicate_version = self.sign(image, "0.3.0", comment="file:OpenWhisper-Linux-x86_64.AppImage\tversion:0.3.0\tversion:0.3.0")
        wrong_filename = self.sign(image, "0.3.0", comment="file:other.AppImage\tversion:0.3.0")
        duplicate_filename = self.sign(image, "0.3.0", comment="file:OpenWhisper-Linux-x86_64.AppImage\tfile:OpenWhisper-Linux-x86_64.AppImage\tversion:0.3.0")
        cases = [(modified, signature), (image, foreign), (image, self.packages["0.2.5"][1]),
                 (image, unsigned_version), (image, duplicate_version), (image, wrong_filename), (image, duplicate_filename)]
        modified.unlink()
        for package, signed in cases:
            if package == modified:
                modified.write_bytes(image.read_bytes() + b"tampered")
            with self.assertRaises(installer.InstallError):
                self.install("0.3.0", package, signed)
            modified.unlink(missing_ok=True)
            self.assertEqual(self.snapshot(), before)

    def test_legacy_unhashed_algorithm_is_rejected(self):
        image, _ = self.packages["0.2.4"]
        signature = self.sign(image, "0.2.4", legacy=True)
        with self.assertRaises(installer.InstallError):
            self.install("0.2.4", signature=signature)

    def test_independent_minisign_vector_and_invalid_frames(self):
        vector = json.loads((SCRIPT.parents[1] / "tests/fixtures/installer-signature.json").read_text())
        image = self.home / "vector"
        image.write_bytes(base64.b64decode(vector["payload"]))
        with patch.object(installer, "PUBLIC_KEY", vector["public_key"]), tempfile.TemporaryDirectory(dir=self.home) as work:
            installer.verify(image, vector["signature"], vector["version"], Path(work))
            lines = base64.b64decode(vector["signature"]).decode().splitlines()
            cases = ["invalid", base64.b64encode(b"invalid utf8\xff").decode()]
            for replacement in (lines[:3], lines + ["extra"], [*lines[:2], "trusted comment: changed", lines[3]]):
                cases.append(base64.b64encode("\n".join(replacement).encode()).decode())
            frame = base64.b64decode(lines[1])
            for malformed in (frame[:-1], b"Ed" + frame[2:], b"XX" + frame[2:], frame[:2] + b"foreign!" + frame[10:]):
                changed = [lines[0], base64.b64encode(malformed).decode(), *lines[2:]]
                cases.append(base64.b64encode("\n".join(changed).encode()).decode())
            for encoded in cases:
                with self.assertRaises(installer.InstallError):
                    installer.verify(image, encoded, vector["version"], Path(work))

    @unittest.skipUnless(shutil.which("minisign"), "Optional independent Minisign oracle unavailable")
    def test_minisign_oracle_accepts_synthetic_hashed_signatures(self):
        for image, signature in self.packages.values():
            detached = self.home / "oracle.minisig"
            detached.write_bytes(base64.b64decode(signature.read_text()))
            subprocess.run(["minisign", "-V", "-H", "-p", str(self.root / "trusted.pub"), "-m", str(image),
                            "-x", str(detached)], check=True, capture_output=True)

    @unittest.skipUnless(os.environ.get("OPENWHISPER_UPDATE_VERIFIER"), "Optional native Rust verifier unavailable")
    def test_native_verifier_matches_signature_and_version_decisions(self):
        config = self.home / "verifier.json"
        config.write_text(json.dumps({"plugins": {"updater": {"pubkey": self.public_key, "requireSignedVersion": True}}}))
        image, signature = self.packages["0.3.0"]
        modified = self.home / "tampered-parity.AppImage"
        modified.write_bytes(image.read_bytes() + b"changed")
        invalid = self.home / "invalid.sig"
        invalid.write_text("malformed")
        comment = self.home / "comment.sig"
        comment.write_text(base64.b64encode(base64.b64decode(signature.read_text()).replace(b"version:0.3.0", b"version:9.9.9")).decode())
        cases = [(image, signature, "0.3.0", True), (modified, signature, "0.3.0", False),
                 (image, signature, "9.9.9", False), (image, invalid, "0.3.0", False),
                 (image, comment, "0.3.0", False), (image, self.sign(image, "0.3.0", identity="foreign"), "0.3.0", False),
                 (image, self.sign(image, "0.3.0", comment="file:OpenWhisper-Linux-x86_64.AppImage"), "0.3.0", False)]
        for package, signed, release, expected in cases:
            result = subprocess.run([os.environ["OPENWHISPER_UPDATE_VERIFIER"], str(config), str(package), str(signed), release],
                                    capture_output=True, timeout=30)
            with tempfile.TemporaryDirectory(dir=self.home) as work:
                accepted = True
                try:
                    installer.verify(package, signed.read_text(), release, Path(work))
                except installer.InstallError:
                    accepted = False
            self.assertEqual(result.returncode == 0, expected, result.stderr.decode(errors="replace"))
            self.assertEqual(accepted, expected)

    @unittest.skipUnless(os.environ.get("OPENWHISPER_RELEASE_APPIMAGE"), "Optional downloaded public package unavailable")
    def test_public_release_installs_without_execution_and_matches_oracles(self):
        image = Path(os.environ["OPENWHISPER_RELEASE_APPIMAGE"])
        signature = Path(os.environ["OPENWHISPER_RELEASE_SIGNATURE"])
        release = os.environ.get("OPENWHISPER_RELEASE_VERSION", "0.2.4")
        with patch.object(installer, "PUBLIC_KEY", PINNED_KEY):
            self.install(release, image, signature)
        self.assertEqual(self.installation.image.read_bytes(), image.read_bytes())
        self.assertEqual(self.installation.icon.read_bytes(), (SCRIPT.parents[1] / "src-tauri/icons/icon.png").read_bytes())
        if verifier := os.environ.get("OPENWHISPER_UPDATE_VERIFIER"):
            subprocess.run([verifier, str(SCRIPT.parents[1] / "src-tauri/tauri.conf.json"), str(image), str(signature), release],
                           check=True, capture_output=True, timeout=60)
        if shutil.which("minisign"):
            public = self.home / "pinned.pub"
            public.write_bytes(base64.b64decode(PINNED_KEY))
            detached = self.home / "public.minisig"
            detached.write_bytes(base64.b64decode(signature.read_text().strip()))
            subprocess.run(["minisign", "-V", "-H", "-p", str(public), "-m", str(image), "-x", str(detached)],
                           check=True, capture_output=True, timeout=60)
        with self.installation.locked():
            self.installation.uninstall()
        self.assertTrue(self.sentinel.exists())

    def test_noncanonical_versions_wrong_architecture_and_downgrade_are_rejected(self):
        for value in ("00.2.5", "0.2", "v0.2.5", "0.2.5-beta", "0.2.5 ", "0.2.18446744073709551616", "0.2." + "9" * 5000, None):
            with self.assertRaises(installer.InstallError):
                installer.version(value)
        self.install("0.3.0")
        with self.assertRaises(installer.InstallError):
            self.install("0.2.5")
        image = self.home / "wrong-architecture.AppImage"
        image.write_bytes(self.packages["0.3.0"][0].read_bytes())
        data = bytearray(image.read_bytes())
        struct.pack_into("<H", data, 18, 183)
        image.write_bytes(data)
        signature = self.sign(image, "0.3.0")
        with self.assertRaises(installer.InstallError):
            self.install("0.3.0", image, signature)

    def test_download_failure_and_metadata_rejection_leave_installation_unchanged(self):
        self.install()
        before = self.snapshot()
        with self.installation.locked(), tempfile.TemporaryDirectory(dir=self.home) as work:
            with patch.object(installer, "download", side_effect=installer.InstallError("owned download failure")):
                with self.assertRaises(installer.InstallError):
                    installer.install(self.installation, "0.3.0", Path(work))
        self.assertEqual(self.snapshot(), before)
        for url in ("http://github.com/juferdinand/OpenWhisper/releases/download/v0.3.0/OpenWhisper-Linux-x86_64.AppImage",
                    installer.release_url("0.3.0", installer.asset_name("0.3.0")) + "?other=1",
                    installer.release_url("0.2.5", installer.asset_name("0.3.0")),
                    "https://github.com/other/OpenWhisper/releases/download/v0.3.0/OpenWhisper-Linux-x86_64.AppImage"):
            feed = {"version": "0.3.0", "platforms": {"linux-x86_64-appimage": {"url": url, "signature": "fixture"}}}
            with self.assertRaises(installer.InstallError):
                installer.validate_feed(json.dumps(feed), "0.3.0")
        for url in ("http://github.com/", "https://github.com.evil.example/", "https://user:password@github.com/", "https://github.com:444/"):
            with self.assertRaises(installer.InstallError):
                installer.https_url(url)

    def test_download_bounds_incomplete_bodies_and_deadline(self):
        class Response(io.BytesIO):
            url = installer.release_url("0.3.0", "latest.json")

            def __init__(self, content, length):
                super().__init__(content)
                self.headers = {} if length is None else {"Content-Length": length}

        for data, length in ((b"a" * 17, None), (b"a", "17"), (b"a", "2"), (b"", "0"), (b"a", "invalid")):
            with patch.object(installer.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value = Response(data, length)
                with self.assertRaises(installer.InstallError):
                    installer.download(Response.url, self.home / "download", 16)
        with patch.object(installer.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = Response(b"abc", "3")
            installer.download(Response.url, self.home / "download", 16)
            self.assertEqual((self.home / "download").read_bytes(), b"abc")
        with patch.object(installer.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = Response(b"abc", "3")
            with patch.object(installer.time, "monotonic", side_effect=[0, 301]):
                with self.assertRaises(installer.InstallError):
                    installer.download(Response.url, self.home / "download", 16)

    def test_missing_resources_and_truncated_icon_leave_prior_installation_unchanged(self):
        self.install()
        before = self.snapshot()
        original = installer.resource

        def truncate_icon(image, offset, name, target):
            original(image, offset, name, target)
            if name.endswith(".png"):
                target.write_bytes(target.read_bytes()[:20])

        for extractor in (truncate_icon, installer.InstallError("owned missing packaged resource fixture")):
            with patch.object(installer, "resource", side_effect=extractor):
                with self.assertRaises(installer.InstallError):
                    self.install("0.3.0")
            self.assertEqual(self.snapshot(), before)
    def test_signing_key_and_signed_version_policy_match_native_updater(self):
        configuration = json.loads((SCRIPT.parents[1] / "src-tauri/tauri.conf.json").read_text())
        self.assertEqual(PINNED_KEY, configuration["plugins"]["updater"]["pubkey"])
        self.assertIs(configuration["plugins"]["updater"]["requireSignedVersion"], True)

    def test_atomic_replacement_rolls_back_every_file_after_late_failure(self):
        self.install("0.2.4")
        before = self.snapshot()
        original = installer.atomic_copy

        def fail_after_payload_replacement(source, target, mode):
            if target == self.installation.manifest and source.name == "manifest.json":
                raise OSError("owned simulated disk failure after AppImage replacement")
            return original(source, target, mode)

        with patch.object(installer, "atomic_copy", side_effect=fail_after_payload_replacement):
            with self.assertRaises(OSError):
                self.install("0.2.5")
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.installation.transaction.exists())

    def test_interrupted_journal_recovers_before_next_operation(self):
        self.install("0.2.4")
        before = self.installation.image.read_bytes()
        with self.installation.locked():
            self.installation.transaction.mkdir()
            index = self.installation.files.index(self.installation.image)
            (self.installation.transaction / str(index)).write_bytes(before)
            state = {"targets": [str(path) for path in [*self.installation.files, self.installation.autostart]],
                     "records": [{"index": index, "exists": True, "mode": 0o755}]}
            (self.installation.transaction / "journal.json").write_text(json.dumps(state))
            self.installation.image.write_bytes(b"incomplete owned fixture")
        with self.installation.locked():
            self.assertEqual(self.installation.image.read_bytes(), before)
        self.assertFalse(self.installation.transaction.exists())

    def test_sigkill_after_payload_replacement_recovers_all_prior_files(self):
        self.install("0.2.4")
        before = self.snapshot()
        program = """
import importlib.util, os, signal, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('installer', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.PUBLIC_KEY = PUBLIC_KEY
installation = module.Installation(Path(HOME), Path(HOME) / 'data', Path(HOME) / 'config')
original = module.atomic_copy
def interrupted(source, target, mode):
    original(source, target, mode)
    if target == installation.image and source.name == 'package.AppImage':
        os.kill(os.getpid(), signal.SIGKILL)
module.atomic_copy = interrupted
with installation.locked(), tempfile.TemporaryDirectory(dir=str(Path(HOME).parent)) as work:
    module.install(installation, '0.3.0', Path(work), Path(IMAGE), Path(SIGNATURE))
"""
        values = {"SCRIPT": str(SCRIPT), "PUBLIC_KEY": self.public_key, "HOME": str(self.home),
                  "IMAGE": str(self.packages["0.3.0"][0]), "SIGNATURE": str(self.packages["0.3.0"][1])}
        child = "\n".join(f"{key} = {value!r}" for key, value in values.items()) + "\n" + program
        result = subprocess.run(["python3", "-c", child], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr.decode())
        self.assertTrue((self.installation.transaction / "journal.json").is_file())
        with self.installation.locked():
            self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.installation.transaction.exists())

    def test_malformed_recovery_journal_preserves_backups_without_mutation(self):
        self.install()
        before = self.snapshot()
        self.installation.transaction.mkdir()
        backup = self.installation.transaction / "0"
        backup.write_bytes(b"owned backup fixture")
        (self.installation.transaction / "journal.json").write_text("incomplete json")
        with self.assertRaises(installer.InstallError):
            with self.installation.locked():
                self.fail("Malformed recovery journal was accepted")
        self.assertEqual(backup.read_bytes(), b"owned backup fixture")
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_invocation_and_changed_xdg_recovery_are_refused(self):
        with self.installation.locked():
            with self.assertRaises(installer.InstallError):
                with self.installation.locked():
                    self.fail("Concurrent invocation was accepted")
            self.installation.transaction.mkdir()
            state = {"targets": [str(path) for path in [*self.installation.files, self.installation.autostart]], "records": []}
            (self.installation.transaction / "journal.json").write_text(json.dumps(state))
        other = installer.Installation(self.home, self.home / "other-data", self.home / "config")
        with self.assertRaises(installer.InstallError):
            with other.locked():
                self.fail("Changed XDG recovery was accepted")
        self.assertTrue((self.installation.transaction / "journal.json").exists())
        with self.installation.locked():
            self.assertFalse(self.installation.transaction.exists())

    def test_foreign_entries_and_symlinks_are_not_overwritten(self):
        self.installation.desktop.parent.mkdir(parents=True)
        self.installation.desktop.write_text("owned unrelated entry")
        with self.assertRaises(installer.InstallError):
            self.install()
        self.installation.desktop.unlink()
        self.installation.destination.parent.mkdir(parents=True, exist_ok=True)
        self.installation.destination.symlink_to(self.sentinel.parent, target_is_directory=True)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(self.sentinel.read_bytes(), b"private user model fixture")

    def test_unmanaged_icon_and_edited_launcher_are_not_overwritten(self):
        self.installation.icon.parent.mkdir(parents=True)
        self.installation.icon.write_bytes(b"owned unrelated icon fixture")
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(self.installation.icon.read_bytes(), b"owned unrelated icon fixture")
        self.installation.icon.unlink()
        self.install()
        edited = self.installation.desktop.read_text() + "X-Owned-Edit=true\n"
        self.installation.desktop.write_text(edited)
        before = self.snapshot()
        with self.assertRaises(installer.InstallError):
            self.install("0.3.0")
        with self.installation.locked():
            with self.assertRaises(installer.InstallError):
                self.installation.uninstall()
        self.assertEqual(self.snapshot(), before)

    def test_disabled_and_foreign_autostart_entries_are_preserved(self):
        self.install()
        self.installation.autostart.parent.mkdir(parents=True)
        owned_exec = f"Exec=env APPIMAGE_EXTRACT_AND_RUN=1 {installer.desktop_argument(str(self.installation.image))}\n"
        for content in ("[Desktop Entry]\nType=Application\nName=OpenWhisper\nHidden=true\n",
                        "[Desktop Entry]\nType=Application\nExec=/owned/other/installation\n",
                        "[Desktop Entry]\nType=Application\nExec=/owned/other/installation\n[Desktop Action Other]\n" + owned_exec,
                        "[Desktop Entry]\nType=Application\n" + owned_exec + "Exec=/owned/other/installation\n"):
            self.installation.autostart.write_text(content)
            self.install("0.3.0")
            with self.installation.locked():
                self.installation.uninstall()
            self.assertEqual(self.installation.autostart.read_text(), content)
            self.install()

    def test_modified_in_app_payload_cannot_be_silently_downgraded(self):
        self.install()
        self.installation.image.write_bytes(b"owned later in-app update fixture")
        with self.assertRaises(installer.InstallError):
            self.install("0.3.0")
        with self.installation.locked():
            self.installation.uninstall()
        self.assertTrue(self.sentinel.exists())

    @unittest.skipUnless(shutil.which("gio") and shutil.which("desktop-file-validate"), "GIO and desktop-file-utils required")
    def test_desktop_exec_round_trip_with_spaces_percent_quotes_backslash_and_shell_metacharacters(self):
        # Run only a test-created marker script, never an AppImage or a real desktop action.
        executable = self.home / "marker % $ ` \\\" program"
        marker = self.home / "argv.json"
        executable.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\n"
                              f"Path({str(marker)!r}).write_text(json.dumps([sys.argv,os.environ.get('APPIMAGE_EXTRACT_AND_RUN')]))\n")
        executable.chmod(0o755)
        entry = self.home / "owned-marker.desktop"
        entry.write_text(installer.desktop_entry(executable))
        subprocess.run(["desktop-file-validate", str(entry)], check=True, capture_output=True)
        subprocess.run(["gio", "launch", str(entry)], check=True, capture_output=True,
                       env=os.environ | {"HOME": str(self.home), "XDG_DATA_HOME": str(self.home / "data"),
                                         "XDG_CONFIG_HOME": str(self.home / "config")}, timeout=10)
        for _ in range(100):
            if marker.exists():
                break
            time.sleep(0.02)
        argv, extract = json.loads(marker.read_text())
        self.assertEqual(argv, [str(executable)])
        self.assertEqual(extract, "1")
        for value in ("/tmp/bad\nExec=bad", "/tmp/bad\tpath", "/tmp/bad\x00path"):
            with self.assertRaises(installer.InstallError):
                installer.desktop_argument(value)


if __name__ == "__main__":
    unittest.main(verbosity=2)
