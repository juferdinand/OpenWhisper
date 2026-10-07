#!/usr/bin/env bash
# Run only in the disposable image described by this directory's Dockerfile.
# Mount scripts, public fixture/model, and a new evidence directory; no host devices/sockets.
set -euo pipefail
[[ -f /.dockerenv && "${WF_OWNED_PACKAGE_CONTAINER:-}" == 1 ]] || {
    echo "This test requires its disposable Docker image; refusing the host." >&2
    exit 1
}
useradd --create-home --uid 1000 tester
mkdir -p /home/tester/.config/whisperfree
printf '%s\n' '{"preserve":"private-container-sentinel"}' > /home/tester/.config/whisperfree/acceptance-sentinel.json
chown -R tester:tester /home/tester /evidence
cat /etc/os-release > /evidence/os-release.txt
dpkg-query -W io-github-whisperfree libwebkit2gtk-4.1-0 'libgtk-3-0*' pipewire wireplumber xvfb dbus python3-gi > /evidence/package-versions.txt
dpkg-query -L io-github-whisperfree > /evidence/package-files.txt
sha256sum /usr/bin/openwhisper-desktop > /evidence/binary-checksum.txt
ldd /usr/bin/openwhisper-desktop > /evidence/ldd.txt
! grep -q 'not found' /evidence/ldd.txt
grep -q '^Name=OpenWhisper$' /usr/share/applications/io.github.whisperfree.desktop
grep -q '^StartupWMClass=io.github.whisperfree$' /usr/share/applications/io.github.whisperfree.desktop
runuser -u tester -- python3 /scripts/run-owned-desktop.py --session x11 --output /evidence/native-ui -- /usr/bin/openwhisper-desktop --ui-smoke-test
runuser -u tester -- python3 /scripts/run-owned-desktop.py --session x11 --output /evidence/capture -- python3 /scripts/test-session.py --owned --recovery --binary /usr/bin/openwhisper-desktop --model /fixtures/ggml-tiny.bin --fixture /fixtures/jfk.wav
private_data="$(sed -n 's/^Isolated test files: //p' /evidence/capture/command.log | tail -n 1)"
[[ "$private_data" == /tmp/openwhisper-desktop-test-* ]] || exit 1
sha256sum "$private_data/config/whisperfree/settings.json" "$private_data/config/whisperfree/history.json" > /evidence/data-before-uninstall.txt
model_link="$(readlink "$private_data/data/whisperfree/models/ggml-tiny.bin")"
apt-get remove -y io-github-whisperfree
test ! -e /usr/bin/openwhisper-desktop
test ! -e /usr/share/applications/io.github.whisperfree.desktop
sha256sum --check /evidence/data-before-uninstall.txt
test "$(readlink "$private_data/data/whisperfree/models/ggml-tiny.bin")" == "$model_link"
grep -q 'private-container-sentinel' /home/tester/.config/whisperfree/acceptance-sentinel.json
printf '%s\n' 'PASS: Debian package installation, native X11 UI/capture/recovery, removal, and private settings/history/model preservation'
