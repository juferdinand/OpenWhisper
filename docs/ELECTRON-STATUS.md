# Release and platform status

OpenWhisper **0.3.0** is the current Electron release for macOS and Linux. Download packages from
the [v0.3.0 release](https://github.com/juferdinand/OpenWhisper/releases/tag/v0.3.0), published
2026-10-09 from tag commit `49d3dd3a99f035dd5f3725d5f3d8e9a9a00a4ff9`. Its assets include the
macOS DMG/ZIP, Linux AppImage/DEB and signatures, `latest.json`, and `SHA256SUMS`. This page records
automated coverage and its limits; it does not claim support for every device, desktop,
distribution, or installation history.

## Packages and validation

| Platform | Release packages | Automated evidence |
| --- | --- | --- |
| macOS 14+ | Universal DMG and ZIP | Universal package verification, signed update admission, and same-identity successor install/relaunch checks |
| Linux x86_64 | AppImage and Debian package | Package/update checks, private audio/runtime tests, and owned desktop/session checks |
| Windows | — | Not implemented; tracked by [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35) |

The Electron migration shipped in [PR #34](https://github.com/juferdinand/OpenWhisper/pull/34),
with quality follow-up in [PR #39](https://github.com/juferdinand/OpenWhisper/pull/39). The
accepted baseline main CI [37999235015](https://github.com/juferdinand/OpenWhisper/actions/runs/37999235015)
passed all 11 jobs. The full [v0.3.0 release workflow](https://github.com/juferdinand/OpenWhisper/actions/runs/38002318769)
then passed for the published tag.

Linux owned desktop coverage includes a native keyboard binding and recording on KDE Plasma 5.27
Wayland, plus keyboard/basic dictation on an X11 profile. Other automated checks use private
virtual audio and owned package/runtime environments; results do not establish
physical-device behavior, GPU inference, all compositor versions, or all distributions. The exact
remaining Linux desktop work is tracked in [#21](https://github.com/juferdinand/OpenWhisper/issues/21),
[#29](https://github.com/juferdinand/OpenWhisper/issues/29), [#30](https://github.com/juferdinand/OpenWhisper/issues/30),
and [#38](https://github.com/juferdinand/OpenWhisper/issues/38).

macOS checks cover universal packaging and owned CPU-based capture/update workflows. The offline
successor test updates an Apple Silicon Universal 0.3.0 predecessor to a private arm64-thin 0.3.1
build; it does not test an Intel successor or production HTTPS. These checks do not establish
physical microphone/TCC behavior, all input insertion targets, Metal selection, or Apple
notarization. Public macOS builds are self-signed and not notarized; see [signing](SIGNING.md).

Linux automated update tests cover offline owned GUI upgrades from Electron 0.3.0 to private 0.3.1
Debian and AppImage packages. The original native 0.2.5 app's GUI updater has **not** been
demonstrated to update to Electron. A Debian package transition component was also checked on one
pinned Kubuntu 24 baseline; that scoped result does not establish an original-app GUI update or
support on every distribution.

## Upgrading from 0.2.5

Install 0.3.0 manually from the Releases page using its DMG/ZIP or Linux package. Do not infer that
preferences, models, recordings, or history have moved between app generations. Back up data you
need before changing installations. The immutable [0.2.5 source and platform record](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
describes the former native hosts and their historical evidence.

Follow-up work in [#36](https://github.com/juferdinand/OpenWhisper/issues/36) covers focused main
and renderer composition, measuring vocabulary performance, and demonstrated test-harness
consolidation. [#11](https://github.com/juferdinand/OpenWhisper/issues/11) tracks optional local
model profiles; [#35](https://github.com/juferdinand/OpenWhisper/issues/35) tracks Windows.
Text-to-speech and structured Obsidian output remain later integrations; ordinary dictation stays
independent.
