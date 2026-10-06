#!/usr/bin/env python3
"""Exercise the release verifier with ephemeral identities, altered files, and replayed versions."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
cli = root / "node_modules/.bin/tauri"
verify = root / "target/debug/examples/verify-update"

with tempfile.TemporaryDirectory(prefix="openwhisper-signature-test-") as tmp:
    work = Path(tmp)
    for name in ["trusted", "foreign"]:
        result = subprocess.run([str(cli), "signer", "generate", "--ci", "-p", "", "-w", str(work / name)], capture_output=True)
        if result.returncode:
            raise SystemExit("Could not create ephemeral test identity")
    config = work / "tauri.conf.json"
    config.write_text(json.dumps({"plugins": {"updater": {
        "pubkey": (work / "trusted.pub").read_text().strip(), "requireSignedVersion": True,
    }}}))
    artifact = work / "fixture.AppImage"
    artifact.write_bytes(b"OpenWhisper public update verification fixture\n")
    signature = Path(str(artifact) + ".sig")

    def sign(identity="trusted", version="0.2.1"):
        env = os.environ | {"TAURI_SIGNING_PRIVATE_KEY": (work / identity).read_text(), "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": ""}
        args = [str(cli), "signer", "sign", str(artifact)]
        if version is not None:
            args += ["--app-version", version]
        result = subprocess.run(args, env=env, capture_output=True)
        if result.returncode:
            raise SystemExit("Could not sign test fixture")

    def check(accepted, announced="0.2.1"):
        result = subprocess.run([str(verify), str(config), str(artifact), str(signature), announced], capture_output=True)
        assert (result.returncode == 0) == accepted, "Unexpected signature-verification result: " + result.stderr.decode("utf8", errors="replace")

    sign()
    check(True)
    check(False, "9.9.9")
    artifact.write_bytes(artifact.read_bytes() + b"modified")
    check(False)
    sign(identity="foreign")
    check(False)
    sign(version=None)
    check(False)
    signature.write_text("invalid signature")
    check(False)
print("PASS: valid update accepted; modified files, foreign keys, replayed versions, unsigned versions, and invalid signatures rejected.")
