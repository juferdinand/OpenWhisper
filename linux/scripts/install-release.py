#!/usr/bin/env python3
"""Install a signed release AppImage for the current user, without running it."""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

REPOSITORY = "https://github.com/juferdinand/OpenWhisper"
PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEMxQTY3Q0I1MzY1RjJCODgKUldTSUsxODJ0WHltd1ZnN3ZNZUphSysrMXNRY2RESlZCV1BMajBtc3ZLR25iOTBnaXNpK01wM1oK"
IDENTITY = "io.github.whisperfree"
MAX_PACKAGE = 512 * 1024 * 1024
MAX_METADATA = 64 * 1024
MAX_SIGNATURE = 4096
LEGACY_RELEASES = {"0.2.1", "0.2.2", "0.2.3", "0.2.4"}
LICENSES = (
    "SPIRV-Headers-CC-BY-4.0.txt", "SPIRV-Headers-LICENSE", "SPIRV-Headers-MIT.txt",
    "Vulkan-Headers-Apache-2.0.txt", "Vulkan-Headers-LICENSE.md", "Vulkan-Headers-MIT.txt",
)


class InstallError(Exception):
    pass


def version(value):
    if not isinstance(value, str) or len(value) > 62 or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        raise InstallError("Version must use canonical X.Y.Z format.")
    parts = tuple(int(part) for part in value.split("."))
    if any(part > 2**64 - 1 for part in parts):
        raise InstallError("Version is out of range.")
    return parts


def asset_name(release):
    # These published packages retain their original filenames and signed metadata.
    version(release)
    return ("WhisperFree" if release in LEGACY_RELEASES else "OpenWhisper") + "-Linux-x86_64.AppImage"


def release_url(release, asset):
    version(release)
    return f"{REPOSITORY}/releases/download/v{release}/{asset}"


def validate_feed(data, release):
    try:
        feed = json.loads(data)
        package = feed["platforms"]["linux-x86_64-appimage"]
        allowed = {release_url(release, asset_name(release))}
        if release in LEGACY_RELEASES:
            allowed.add(f"https://github.com/juferdinand/WhisperFree/releases/download/v{release}/{asset_name(release)}")
        if feed["version"] != release or package["url"] not in allowed:
            raise InstallError("Release metadata does not match the requested version and exact package source.")
        signature = package["signature"]
        if not isinstance(signature, str) or len(signature) > MAX_SIGNATURE:
            raise InstallError("Invalid release signature metadata.")
        return signature
    except (ValueError, KeyError, TypeError) as error:
        raise InstallError("Invalid release metadata.") from error


def https_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment
            or parsed.port not in (None, 443)
            or parsed.hostname not in {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}):
        raise InstallError("Download redirected outside the allowed HTTPS release hosts.")


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, request, fp, code, message, headers, url):
        https_url(url)
        return super().redirect_request(request, fp, code, message, headers, url)


def download(url, target, limit):
    https_url(url)
    start = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": "OpenWhisper-terminal-installer", "Accept-Encoding": "identity"})
    try:
        with urllib.request.build_opener(ReleaseRedirect()).open(request, timeout=30) as response:
            https_url(response.url)
            length = response.headers.get("Content-Length")
            if length is not None and (not length.isdigit() or int(length) > limit):
                raise InstallError("Download exceeds the size limit.")
            received = 0
            with target.open("wb") as output:
                while True:
                    if time.monotonic() - start > 300:
                        raise InstallError("Download exceeded the five-minute limit.")
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > limit:
                        raise InstallError("Download exceeds the size limit.")
                    output.write(chunk)
            if received == 0 or (length is not None and received != int(length)):
                raise InstallError("The download is empty or incomplete.")
    except (OSError, ValueError) as error:
        raise InstallError("Release download failed; the installed application was not changed.") from error


def verify(image, encoded_signature, release, work):
    version(release)
    try:
        text = base64.b64decode(encoded_signature.strip(), validate=True).decode("utf8")
        lines = text.splitlines()
        if (len(lines) != 4 or not lines[0].startswith("untrusted comment: ")
                or not lines[2].startswith("trusted comment: ")):
            raise ValueError("Invalid Minisign encoding")
        payload_signature = base64.b64decode(lines[1], validate=True)
        comment_signature = base64.b64decode(lines[3], validate=True)
        key_lines = base64.b64decode(PUBLIC_KEY, validate=True).decode("utf8").splitlines()
        if len(key_lines) != 2 or not key_lines[0].startswith("untrusted comment: "):
            raise ValueError("Invalid pinned public key")
        public = base64.b64decode(key_lines[1], validate=True)
        if (len(payload_signature) != 74 or payload_signature[:2] != b"ED"
                or len(comment_signature) != 64 or len(public) != 42 or public[:2] != b"Ed"
                or payload_signature[2:10] != public[2:10]):
            raise ValueError("Unsupported signature algorithm, frame, or key ID")
        # Minisign ED format: Ed25519(BLAKE2b-512(file)) and a second Ed25519
        # signature over the payload signature plus UTF-8 trusted comment.
        # Cryptographic operations use the distribution's OpenSSL, not Python crypto.
        # https://jedisct1.github.io/minisign/ ; Ed25519 SPKI encoding: RFC 8410.
        key = work / "public-key.der"
        key.write_bytes(bytes.fromhex("302a300506032b6570032100") + public[10:])
        digest = hashlib.blake2b(digest_size=64)
        with image.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        payload = work / "payload.hash"
        payload.write_bytes(digest.digest())
        comment = work / "trusted-comment"
        comment.write_bytes(payload_signature[10:] + lines[2][len("trusted comment: "):].encode("utf8"))
        for source, detached in [(payload, payload_signature[10:]), (comment, comment_signature)]:
            signature = work / "detached.signature"
            signature.write_bytes(detached)
            result = subprocess.run(["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER",
                                     "-inkey", str(key), "-in", str(source), "-sigfile", str(signature)],
                                    capture_output=True, timeout=120)
            if result.returncode:
                raise InstallError("Package or trusted-comment signature verification failed.")
        comments = lines[2][len("trusted comment: "):].split("\t")
        if [part for part in comments if part.startswith("version:")] != [f"version:{release}"]:
            raise InstallError("The signed package version does not match the requested release.")
        if [part for part in comments if part.startswith("file:")] != [f"file:{asset_name(release)}"]:
            raise InstallError("The signed package filename does not match the expected AppImage.")
    except (ValueError, UnicodeError, subprocess.TimeoutExpired) as error:
        raise InstallError("Invalid package signature.") from error


def squashfs_offset(image):
    with image.open("rb") as stream:
        data = stream.read(16 * 1024 * 1024)
    if (data[:6] != b"\x7fELF\x02\x01" or data[8:11] != b"AI\x02"
            or len(data) < 64 or struct.unpack_from("<H", data, 18)[0] != 62):
        raise InstallError("The signed package is not a Linux x86_64 type-2 AppImage.")
    offset = -1
    while True:
        offset = data.find(b"hsqs", offset + 1)
        if offset < 0:
            raise InstallError("AppImage SquashFS data was not found.")
        if offset + 96 <= len(data) and struct.unpack_from("<HH", data, offset + 28) == (4, 0):
            used = struct.unpack_from("<Q", data, offset + 40)[0]
            if 96 <= used <= image.stat().st_size - offset:
                return offset


def resource(image, offset, name, target):
    # Passive extraction of exact files; never execute AppRun or the AppImage runtime.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        result = subprocess.run(["unsquashfs", "-cat", "-offset", str(offset), str(image), name],
                                stdout=output, stderr=errors, timeout=30)
        output.seek(0)
        data = output.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise InstallError("Packaged resource exceeds the size limit.")
        if result.returncode != 0 or not data:
            raise InstallError(f"Required packaged resource is missing: {name}")
        target.write_bytes(data)


def desktop_argument(value):
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise InstallError("Installation paths cannot contain control characters.")
    quoted = '"' + "".join(("\\" if char in '\\"`$' else "") + ("%%" if char == "%" else char) for char in value) + '"'
    return quoted.replace("\\", "\\\\")


def desktop_entry(image):
    return ("[Desktop Entry]\nType=Application\nName=OpenWhisper\nComment=Free, local dictation\n"
            f"Exec=env APPIMAGE_EXTRACT_AND_RUN=1 {desktop_argument(str(image))}\n"
            f"Icon={IDENTITY}\nStartupWMClass={IDENTITY}\nStartupNotify=true\nTerminal=false\nCategories=AudioVideo;Audio;\n")


def owned_path(path):
    """Reject symlinks and paths controlled by another user before writes/removals."""
    if not path.is_absolute() or any(ord(char) < 32 or ord(char) == 127 for char in str(path)):
        raise InstallError("HOME and XDG paths must be absolute and contain no control characters.")
    for component in [*reversed(path.parents), path]:
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise InstallError(f"Refusing symbolic-link installation path: {component}")
        if component != path and not stat.S_ISDIR(info.st_mode):
            raise InstallError(f"Installation parent is not a directory: {component}")
        if info.st_uid not in {0, os.getuid()} or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise InstallError(f"Installation path is not privately controlled: {component}")
    if path.exists() and path.stat().st_uid != os.getuid():
        raise InstallError(f"Installation target is not owned by this user: {path}")


def atomic_copy(source, target, mode):
    owned_path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".openwhisper-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as stream:
            shutil.copyfileobj(stream, output)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, target)
        sync_directory(target.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Installation:
    def __init__(self, home, data, config):
        self.destination = home / ".local/lib/whisperfree"
        self.control = home / ".local/lib/.openwhisper-installer"
        self.image = self.destination / "OpenWhisper.AppImage"
        self.manifest = self.destination / ".terminal-installer.json"
        self.desktop = data / f"applications/{IDENTITY}.desktop"
        self.icon = data / f"icons/hicolor/256x256/apps/{IDENTITY}.png"
        self.autostart = config / f"autostart/{IDENTITY}.desktop"
        self.files = [self.destination / name for name in ("LICENSE", "THIRD_PARTY_NOTICES.md", "Inter-LICENSE.txt", *[f"licenses/{name}" for name in LICENSES])]
        self.files += [self.icon, self.desktop, self.image, self.destination / "OpenWhisper.AppImage.sig", self.manifest]
        self.transaction = self.control / "transaction"

    def target_paths(self):
        return [str(path) for path in [*self.files, self.autostart]]

    @contextlib.contextmanager
    def locked(self):
        for path in [self.control, self.autostart, *self.files]:
            owned_path(path)
        self.control.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = self.control / "lock"
        owned_path(lock_path)
        with lock_path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise InstallError("Another terminal installer is already running.") from error
            self.recover()
            yield

    def recover(self):
        if not self.transaction.exists():
            return
        owned_path(self.transaction)
        if (self.transaction / "committed.json").exists():
            # Completion was durably recorded before deleting backups.
            shutil.rmtree(self.transaction)
            sync_directory(self.control)
            return
        journal = self.transaction / "journal.json"
        if not journal.exists():
            # Publication precedes every mutation; only abandoned staging exists here.
            shutil.rmtree(self.transaction)
            sync_directory(self.control)
            return
        owned_path(journal)
        try:
            if journal.stat().st_size > MAX_METADATA:
                raise ValueError("Journal is too large")
            state = json.loads(journal.read_text())
            if state["targets"] != self.target_paths():
                raise InstallError("Interrupted installation used different HOME/XDG paths. Restore those environment variables before retrying.")
            records = state["records"]
            if not isinstance(records, list) or len(records) > len(self.files) + 1:
                raise ValueError("Invalid transaction records")
            indices = set()
            for record in records:
                index = record["index"]
                if (type(index) is not int or index not in range(len(self.files) + 1)
                        or index in indices or type(record["exists"]) is not bool
                        or type(record["mode"]) is not int or not 0 <= record["mode"] <= 0o777):
                    raise ValueError("Invalid transaction record")
                indices.add(index)
                if record["exists"]:
                    backup = self.transaction / str(index)
                    owned_path(backup)
                    if not backup.is_file():
                        raise ValueError("Missing transaction backup")
        except (ValueError, KeyError, TypeError) as error:
            raise InstallError("Interrupted installation journal is invalid. Backups were preserved; resolve it before retrying.") from error
        for record in reversed(records):
            index = record["index"]
            target = self.autostart if index == len(self.files) else self.files[index]
            owned_path(target)
            if record["exists"]:
                backup = self.transaction / str(index)
                owned_path(backup)
                atomic_copy(backup, target, record["mode"])
            else:
                target.unlink(missing_ok=True)
                if target.parent.exists():
                    sync_directory(target.parent)
        self.finish()

    def finish(self):
        os.replace(self.transaction / "journal.json", self.transaction / "committed.json")
        sync_directory(self.transaction)
        shutil.rmtree(self.transaction)
        sync_directory(self.control)

    def apply(self, changes):
        self.transaction.mkdir(mode=0o700)
        sync_directory(self.control)
        records = []
        try:
            for target, source, mode in changes:
                owned_path(target)
                index = len(self.files) if target == self.autostart else self.files.index(target)
                record = {"index": index, "exists": target.exists(), "mode": 0o644}
                if target.exists():
                    if not target.is_file():
                        raise InstallError("Installation target is not a regular file.")
                    record["mode"] = stat.S_IMODE(target.stat().st_mode) & 0o777
                    atomic_copy(target, self.transaction / str(index), 0o600)
                records.append(record)
            journal = self.transaction / "journal.json"
            pending = self.transaction / "journal.pending"
            pending.write_text(json.dumps({"targets": self.target_paths(), "records": records}))
            atomic_copy(pending, journal, 0o600)
            for target, source, mode in changes:
                if source is None:
                    target.unlink(missing_ok=True)
                    sync_directory(target.parent)
                else:
                    atomic_copy(source, target, mode)
        except BaseException:
            self.recover()
            raise
        self.finish()

    def installation_record(self):
        try:
            if self.manifest.stat().st_size > MAX_METADATA:
                raise ValueError("Installation record is too large")
            previous = json.loads(self.manifest.read_text())
            version(previous["version"])
            if not isinstance(previous["image_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", previous["image_sha256"]):
                raise ValueError("Invalid recorded AppImage hash")
            if previous["targets"] != self.target_paths():
                raise InstallError("Installation used different HOME/XDG paths. Restore those environment variables before retrying.")
            return previous
        except (ValueError, KeyError, TypeError, OSError) as error:
            raise InstallError("Invalid installation record; no files were changed.") from error

    def previous(self):
        if not self.manifest.exists():
            if any(path.exists() for path in self.files):
                raise InstallError("An unmanaged installation exists. Keep it unchanged or uninstall it manually before using this installer.")
            return None
        previous = self.installation_record()
        try:
            if previous["image_sha256"] != sha256(self.image):
                raise InstallError("The AppImage changed outside this installer (for example, through the in-app updater). Use the in-app updater, or uninstall before reinstalling; your data will be preserved.")
            if self.desktop.exists() and self.desktop.read_text() != desktop_entry(self.image):
                raise InstallError("The desktop entry was changed; restore or remove it manually before reinstalling.")
            return previous
        except (ValueError, KeyError, OSError) as error:
            raise InstallError("Invalid installation record; no files were changed.") from error

    def uninstall(self):
        if not self.manifest.exists():
            raise InstallError("No installation managed by this terminal installer was found.")
        self.installation_record()
        if self.desktop.exists() and self.desktop.read_text() != desktop_entry(self.image):
            raise InstallError("The desktop entry was changed; remove it manually before uninstalling.")
        changes = [(path, None, 0) for path in self.files if path.exists()]
        if self.autostart.exists():
            content = self.autostart.read_text()
            expected = f"Exec=env APPIMAGE_EXTRACT_AND_RUN=1 {desktop_argument(str(self.image))}"
            in_entry = False
            commands = []
            for line in content.splitlines():
                line = line.strip()
                if line.startswith("["):
                    in_entry = line == "[Desktop Entry]"
                elif in_entry and line.startswith("Exec="):
                    commands.append(line)
            if commands == [expected]:
                changes.append((self.autostart, None, 0))
        self.apply(changes)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def install(installation, release, work, offline_image=None, offline_signature=None):
    previous = installation.previous()
    if previous and version(release) < version(previous["version"]):
        raise InstallError("Refusing to downgrade the installed AppImage.")
    image = work / "package.AppImage"
    if offline_image:
        if not offline_image.is_file() or offline_image.stat().st_size > MAX_PACKAGE:
            raise InstallError("Offline AppImage is missing or exceeds the size limit.")
        if not offline_signature.is_file() or offline_signature.stat().st_size > MAX_SIGNATURE:
            raise InstallError("Offline signature is missing or exceeds the size limit.")
        shutil.copyfile(offline_image, image)
        signature = offline_signature.read_text().strip()
    else:
        metadata = work / "latest.json"
        download(release_url(release, "latest.json"), metadata, MAX_METADATA)
        signature = validate_feed(metadata.read_bytes(), release)
        download(release_url(release, asset_name(release)), image, MAX_PACKAGE)
    verify(image, signature, release, work)
    offset = squashfs_offset(image)
    staged = []
    for target in installation.files[:-5]:
        relative = target.relative_to(installation.destination).as_posix()
        output = work / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        resource(image, offset, f"usr/lib/{IDENTITY}/{relative}", output)
        staged.append((target, output, 0o644))
    icon = work / "icon.png"
    resource(image, offset, f"{IDENTITY}.png", icon)
    header = icon.read_bytes()[:24]
    if len(header) != 24 or header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" or struct.unpack(">II", header[16:24]) != (256, 256):
        raise InstallError("The package icon is not the expected 256px PNG.")
    entry = work / "application.desktop"
    entry.write_text(desktop_entry(installation.image))
    signed = work / "package.sig"
    signed.write_text(signature + "\n")
    manifest = work / "manifest.json"
    manifest.write_text(json.dumps({"version": release, "image_sha256": sha256(image),
                                    "targets": installation.target_paths()}, indent=2) + "\n")
    staged += [(installation.icon, icon, 0o644), (installation.desktop, entry, 0o644),
               (installation.image, image, 0o755), (installation.files[-2], signed, 0o644),
               (installation.manifest, manifest, 0o600)]
    installation.apply(staged)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--version", help="Exact stable release version, for example 0.2.4")
    operation.add_argument("--uninstall", action="store_true", help="Remove installer-managed app files, keeping user data")
    parser.add_argument("--appimage", type=Path, help="Offline AppImage (requires --signature)")
    parser.add_argument("--signature", type=Path, help="Offline release .sig file (requires --appimage)")
    args = parser.parse_args()
    try:
        if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
            raise InstallError("This installer supports Linux x86_64 only.")
        if os.getuid() == 0:
            raise InstallError("Run this installer as your regular user, without sudo.")
        if bool(args.appimage) != bool(args.signature) or (args.uninstall and args.appimage):
            raise InstallError("Offline installation requires --version, --appimage, and --signature together.")
        if args.version:
            version(args.version)
            for tool in ["openssl", "unsquashfs"]:
                if not shutil.which(tool):
                    raise InstallError(f"Required tool is missing: {tool}. Install OpenSSL 3 and squashfs-tools using your distribution package manager.")
            openssl = subprocess.run(["openssl", "version"], capture_output=True, text=True, timeout=10)
            match = re.match(r"OpenSSL ([0-9]+)\.", openssl.stdout)
            if openssl.returncode or not match or int(match[1]) < 3:
                raise InstallError("OpenSSL 3 or newer is required for Ed25519 verification.")
        home = Path(os.environ.get("HOME", ""))
        if not str(home) or not home.is_absolute():
            raise InstallError("An absolute HOME directory is required.")
        data = Path(os.environ.get("XDG_DATA_HOME", str(home / ".local/share")))
        config = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
        installation = Installation(home, data, config)
        with installation.locked():
            if args.uninstall:
                installation.uninstall()
                print("Removed the installer-managed application. Settings, models, snippets, history, and recordings were preserved.")
            else:
                with tempfile.TemporaryDirectory(prefix="download-", dir=installation.control) as directory:
                    install(installation, args.version, Path(directory), args.appimage, args.signature)
                print(f"Installed verified OpenWhisper {args.version} for this user.")
                print("Open OpenWhisper from your application launcher. The installer does not launch the app or change launch-at-login preferences.")
    except (InstallError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
