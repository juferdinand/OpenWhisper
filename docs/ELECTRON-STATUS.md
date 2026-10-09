# Electron implementation status

Target version: **0.3.0**, replacing the existing Swift/Rust application hosts.
Implementation: [draft PR #34](https://github.com/juferdinand/OpenWhisper/pull/34),
tracked by [issue #33](https://github.com/juferdinand/OpenWhisper/issues/33).
The installed stable application is still 0.2.5.
Windows is separate follow-up work in [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35).
Folder/documentation cleanup is tracked in [issue #36](https://github.com/juferdinand/OpenWhisper/issues/36).

Track completion by the functional milestones below. The full migration is still
incomplete; the table distinguishes runnable behavior from remaining replacement work.

| Area | Current result | Remaining work |
| --- | --- | --- |
| Plan and architecture | Reviewed plan, repository research answers and issue/PR review recorded | Keep decisions aligned with final implementation |
| Shared interface and services | Existing design, strict TS bridge, isolated Dev profile, settings, models/history and localized shared-owner tray actions; sandboxed recording overlay connected | Native tray presentation, assembled Mac overlay and remaining platform behaviors |
| Linux dictation | CPU recognition, clipboard/history, Retry/Discard and original cleanup pass in exact Dev/stable packages with private virtual audio. The installed stable package also passes migration, command control, autostart and permanent-target restart | Accelerated inference; an earlier final-Quit hang did not reproduce and remains unclassified |
| macOS dictation | Actual Intel/Apple Silicon thin Dev/Stable and same-ZIP Universal Stable packages pass sandbox, signed utilities, public-audio CPU recognition, shortcut setup/removal, migration, edited-state restart and clean exits at 5bfd71b1 | Physical microphone/TCC, actual target insertion, device changes and Metal selection remain open |
| Linux desktop integration | Owned stock KDE 5.27 native Wayland F8, binding Quit/crash recovery and paste into separate Wayland/XWayland editors pass. Genuine X11 shortcuts and all five no-display CLI commands pass, including installed stable autostart enable/disable and generated-target restart | Expanded named-desktop, GNOME consent, wlroots, modifier/mouse, layout and overlay stacking coverage is deferred to follow-up tickets |
| Optional model communication | Isolated manual local-model preview port exists | Live LM Studio/Ollama trials and remaining provider/workflow scope are deferred to #11, outside 0.3.0; ordinary dictation remains independent |
| Packaging and updates | A genuine signed Electron Debian 0.3.0→private 0.3.1 GUI upgrade passes with real installation, same-PID restart and preserved preferences in an offline owned container. Signed installed mutation guards and canonical AppImage construction pass. Both Mac thin and Universal runtime jobs pass on Intel and ARM | Production HTTPS/Polkit composition, native 0.2.5 transition, AppImage upgrade/migration, persistent Mac publisher/installation/relaunch, authenticated Dev replacement and signed release packages |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

## Current package checkpoint

The current source increment passes strict typing, the normal application/shared
UI build and 1,291 tests: 1,337 total, zero failures and 46 explicit native/opt-in
skips in 17.87 seconds. Independent source reviews pass. The genuine signed
Debian upgrade and latest Mac results are recorded below.

Debian updates connect directly to the existing
parent supervisor, V2 channel and shared Update controls. Only a canonical
installed Debian version admits the capability. The parent owns the fixed
feed, authenticated original download, installer and installed audit. Original
GUI/native cleanup, retirement acknowledgment and clean duplex/process closure
precede installation; authorization and full hashing have a separate long phase.
A synchronous physical metadata check immediately precedes fixed-target exec.
The actual canonical package from producer `a70819eb` (direct parent `c19cb056`)
passes an owned, network-disabled Debian V2/UI check in 22.39 seconds. The shared
Update control reports checking then error; inherited hints are consumed, saved
data remains intact, and the original GUI/supervisor close normally. All observed
app processes disappear and the namespace is removed. This check performs no
recording, installation, retirement or restart and does not prove an upgrade.

Normal Linux CI exports a fresh canonical Stable validation package
and the already-built, locked signer/verifier tools from the same source.
An owner-only dependent job admits those inputs before accessing the existing
signing key, verifies exact signed bytes and version through both packaged
Electron and the native oracle, then installs and audits inside a disposable
Ubuntu 22.04 container. An altered installed notice must be rejected.
Missing signing material is explicitly unavailable. In
[CI 37894973906](https://github.com/juferdinand/OpenWhisper/actions/runs/37894973906),
actual producer `32465416`, candidate admission, signing with the existing key,
packaged fixed-key verification and the legacy verifier pass. The installed audit
fails at its generic physical-audit boundary; its underlying cause was not logged.
The later original signed job in
[CI 37897858417](https://github.com/juferdinand/OpenWhisper/actions/runs/37897858417),
producer `a70819eb`, passes the actual installed positive, fresh mismatch and
same-retained-snapshot mutation refusal under packaged Electron. Original source
closure and staging removal complete before the final guard: accepted for the
unchanged installation and refused after mutation. The original container exits 0
and is removed. This supersedes the earlier audit failure without assigning its
unlogged cause. The later genuine Debian upgrade below establishes same-PID exec
within its explicitly offline, owned installation scope.

The next canonical CI path also wraps that same completed Stable directory in an
AppImage, using checksum-checked appimagetool/runtime inputs without another native
build. Its separate receipt binds the fixed image, launcher and construction
provenance before the existing owner-only signer. Both embedded and native
verifiers require the exact signed version. Actual construction and passive
extraction pass in CI 37907145876 at producer `d47e8d76`; the dependent signature
job subsequently passes existing-key signing and exact/wrong-version verification
for both Linux formats, plus Debian installation/audit. Construction performs no AppImage launch
or upgrade.

AppImage now connects to the existing V2 parent channel and shared Update controls.
Structural admission can provision only the missing fixed launcher after checking
the original live image's kernel ancestry and physical layout. This local step
does not access the network or authorize installation. An explicit Check now
authenticates the installed image/signature pair; a missing or stale sidecar can
be repaired from the bounded signature for the exact current release, verified
against the original image and existing key before publication. Candidate preparation
requires this signed-current guard. Automatic checks remain suppressed until a
successful explicit check in each session; the saved preference is preserved.
The consumer preserves and restores the image/signature pair and checks the
installed target after original descriptor closure, immediately before exec.
Focused cached-signature and inert-predecessor fixtures establish source behavior,
not a genuine newer signed upgrade. Actual installed migration and same-PID
restart remain open. Clean Stable construction supports the fixed release asset
name without granting signing or publication authority.

The Mac replacement transaction authenticates the candidate against the
running application's designated requirement before any swap, copies to a private
sibling, and retains the predecessor with exclusive same-filesystem renames.
Physical tree checks and guarded rollback preserve foreign replacements. Five
owned-file cases pass with synthetic publisher/rename effects; they do not prove
Darwin installation or relaunch. Main now connects shared Update controls to the
existing bounded feed/download/archive services. Original archive owners close
before handoff, and original native recording/speech cleanup precedes replacement
and the fixed captured-executable relaunch. Immediate failures restore only the
same transaction; a retired session cannot advertise recording availability.
Scheduling relaunch supplies no successor acknowledgment, so the predecessor
remains retained after successful scheduling. Actual installation/relaunch and
new-version confirmation remain open.

Ordinary builds and persistent validation alone keep Mac updates disabled. Only
an explicit `--enable-updates` persistent Stable package embeds the fixed repository
and exact certificate fingerprint before signing. Runtime checks bind the strict
all-architecture certificate requirement to the current process's designated
requirement and require a writable installation parent. This capability is optional;
an unavailable publisher or installation must not prevent ordinary dictation.
Failed downloads retain their original cleanup obligation. Original resource
settlement is distinct from private filesystem cleanup: Quit can preserve refused
files only after the original transport/read/file owners are known to have settled.

The next owned Mac publisher job reuses admitted same-run thin packages and the
existing signing identity, then compares the candidate with the original pinned
0.2.5 binary's designated requirement. Temporary credentials are cleaned before
runtime acceptance. The next candidate explicitly configures updates; owned smoke
checks actual main/UI admission, then disables automatic metadata checks through
ordinary preferences. Startup might already have made its normal metadata request;
the harness neither initiates an installation nor claims network absence.
The first actual invocation stops in original ZIP listing admission, before
extraction or credentials. Its format correction and remaining results are below;
this is not yet a persistent-publisher or installation result.

All five relevant Mac jobs in
[normal CI 37892162932](https://github.com/juferdinand/OpenWhisper/actions/runs/37892162932)
pass: both thin producers, Universal construction and both normal Universal
runtime checks. Original logs print actual synthetic producer `5bfd71b1`,
distinct from API head `6c3743ec`. ARM and Intel finish at
`restarted-original-quit` after the required ordinary UI, native composition,
public-audio CPU recognition and restart checks. No capture device is opened.
The consoles do not print the selected publisher-availability branch; this
does not establish an updater positive or persistent-certificate continuity.
The earlier ARM refusal remains unclassified; unchanged admission requirements
and deadlines pass in this invocation, without proving a diagnostic-caused fix.

Later [CI 37897858417](https://github.com/juferdinand/OpenWhisper/actions/runs/37897858417),
actual producer `a70819eb`, fails Intel's early-exit retirement fixture and ARM's
shortcut setup. The reviewed Intel fixture now establishes kernel PID absence
before testing absent-at-bind behavior. Both thin jobs in the following
[CI 37901055238](https://github.com/juferdinand/OpenWhisper/actions/runs/37901055238)
pass retirement but fail the newly isolated `shortcut-capture-start` phase.
The setup operation holds the recording-control reservation and previously
rejected itself through the global recording guard. The source correction gives
setup its own idle/recovery/shutdown/update checks while keeping global recording
reserved. The new composition regression and all ten focused shortcut cases pass;
timeouts and runtime assertions are unchanged. Confirmation in actual Mac CI and
the dependent persistent-publisher job remains pending.

The following [CI 37903127605](https://github.com/juferdinand/OpenWhisper/actions/runs/37903127605),
actual synthetic producer `38d8c608` (API head `ef0c9158`), stops all three Mac jobs
in the default unit suite before application packaging or smoke. Three AppImage
parent fixtures and five Mac transaction fixtures pass temporary aliases into
physical-ancestry admission. Their reviewed correction canonicalizes only the
owned temporary roots with `realpath`; production safety rules remain unchanged.
This failure supplies no runtime result for the preceding shortcut correction.

The next [CI 37906049896](https://github.com/juferdinand/OpenWhisper/actions/runs/37906049896),
actual synthetic producer `ddbff5cd` (API head `2f3a4fb1`), passes the Mac default
unit suite and the Intel owned native/package job. ARM stops in the production
retirement fixture's early-exit case: the helper exit is observed while both
native snapshots still contain process records. The fixture now waits for its
original PID to become absent within the same case deadline, then independently
requires native reap and close confirmation. Production retirement rules are
unchanged; the exact record-state rejection cause was not retained.

The same run's Ubuntu candidate job stops before AppImage construction at an
informational extractor-version command. `unsquashfs -version` can print its
valid banner and return 1; the correction accepts only status 0/1 with the expected
banner and records the status. Constructor, extraction and signature failures
remain mandatory failures. Actual AppImage construction/signatures and the
corrected ARM fixture still require the next normal CI result. Persistent and
Universal Mac dependent jobs are skipped in this run.

The following [CI 37907145876](https://github.com/juferdinand/OpenWhisper/actions/runs/37907145876),
actual synthetic producer `d47e8d765207e5c056a27f0b57bea9d1c011a06b`
(API head `cc38463a`), passes both thin Mac jobs, Universal construction, Intel
Universal runtime, Ubuntu Electron/AppImage construction and legacy Linux.
The original ARM thin log confirms the corrected retirement case, Dev original
Quit and Stable edited-state restart/Quit. CPU inference is confirmed in Dev;
the thin Stable harness does not run that block. These results confirm the
previous fixture corrections, without establishing persistent publisher or
upgrade acceptance.

The persistent publisher stops before credentials because its `zipinfo -T -l`
parser omitted the compressed-size column and rejected the original valid `bX`
extra-field flag. The reviewed correction requires a safe numeric compressed
size and the closed `[bt][xX-]` flag grammar. Eleven focused checks pass, including
original directory/file/framework-link rows and malformed size/flag negatives.
Passive parsing of all 2,324 original entries passes: 1,888 files, 422 directories
and 14 framework links. Source, path, extraction and signing guards remain intact.
The next actual publisher job must confirm the corrected path.

Universal ARM starts the normal app but strict bundle signature verification
exceeds its ten-second deadline: SIGTERM at 10,090 ms. The same bundle's preceding
15-second harness preflight passes under a different HOME/TMPDIR. The production
deadline is aligned to 15 seconds, with strict/deep checks, bounded output and
closed failure behavior unchanged. Independent source review passes; the cause
of the delay and sufficiency of the new budget remain unproven until actual CI.
No invalid signature or later metadata/login failure is inferred.

Two genuinely distinct private host-local Stable Debian packages, 0.3.0 at
`cc38463a` and version-only child 0.3.1 at `8275e9bf`, are also constructed with
the existing builders in the same owned worktree. Both version/source identities
are verified; tracked native inputs and cached native output manifests remain
unchanged, and the second build reports no native work. Five original commands
succeed in approximately 15 seconds, including restoration of the original
branch/head and ordinary Dev build. This removes the need for another native
reuse API. These unsigned packages require host glibc 2.43 and cannot establish
Ubuntu 22.04 compatibility, signing, runtime acceptance or a genuine upgrade.
The installed app, protected LiveDev, remote branches and public releases are
untouched by this private construction.

### Signed Debian upgrade and current Mac result

[CI 37910264039](https://github.com/juferdinand/OpenWhisper/actions/runs/37910264039),
actual synthetic producer `9e689c1a` (API head `d5f3e23a`), passes both thin Mac
jobs, Universal construction and both ordinary Universal runtime jobs. ARM now
completes the production signature check and reaches `restarted-original-quit`
with the 15-second budget. This confirms this invocation; it does not identify
the earlier delay's cause. Persistent publisher ZIP admission and the pinned
original 0.2.5 designated-requirement admission pass, but keychain identity
selection stops before successor signing. The reviewed correction reads matching
Code Signing identities rather than only identities trusted by Apple's default
policy. It admits exactly one matching identity and only the explicit
`CSSMERR_TP_NOT_TRUSTED` exception for a self-signed certificate; all actual
signing, original-publisher and package verification gates remain mandatory.
Actual persistent publisher success still requires the next normal CI result.

Fresh Ubuntu 22.04 packages use genuine versioned sources: 0.3.0 at `16bb0af5`
and its private version-only 0.3.1 child `8433def6`. The second version reuses
unchanged native inputs/artifacts. Both canonical Debian archives are signed
with the existing key; the existing native verifier accepts their exact version
and rejects a wrong version. Neither private version is tagged or published.

The [owned Debian upgrade runner](../electron/tests/owned-debian-upgrade/README.md)
installs the older package and drives the ordinary shared **Check now** and
**Download & install** controls. The packaged production verifier prepares the
actual newer signed archive. Original GUI/native PIDs are absent before real
`dpkg --install`; installed audit, original source closure and final metadata
guard precede real fixed-target `process.execve`. The original supervisor retains
both PID and kernel start time. The successor confirms its actual 0.3.1 version,
source identity and unchanged edited preferences, then quits normally. All
observed descendants and fixture services close; the stopped container has PID 0
and is removed. Frozen package and payload inventories remain unchanged.

This is an actual Electron-to-Electron upgrade in an owned, network-disabled
container. The feed/download are local fixtures and the installer runs as root
only inside that namespace. It does not prove production HTTPS, Polkit consent,
native 0.2.5 migration, AppImage upgrades or physical desktop coverage. The first
attempt stopped before installation at the retirement/installer boundary with
an unlogged underlying cause. After bounded kernel-PID absence observation and
prompt harness failure reporting were added, the second attempt passes using
the same immutable package pair. Production retirement requirements are unchanged.

### Preceding Universal failure and reviewed correction

In [normal CI 37889109350](https://github.com/juferdinand/OpenWhisper/actions/runs/37889109350),
both thin Mac jobs and Universal construction pass at actual synthetic producer
`866c3a74`, distinct from API head `38d607e1`. Both Universal consumers now
prepare the checksum-pinned public audio successfully. ARM launches the normal
app but exits during `mac-bundle` admission with a generic bootstrap failure;
the specific tool or metadata cause is not established. Intel initializes the
packaged UI and sandbox, then fails the self-update signature expectation with
`INVALID_SIGNATURE` / `-67050`. Neither result proves the remaining Universal
CPU/recording/quit checks. The existing production all-architecture publisher
requirement remains mandatory; ad-hoc fixture evidence does not establish
persistent-certificate update continuity.

The reviewed source increment adds fixed, content-free bundle failure categories
without changing admission requirements or tool deadlines. The owned Mac test
uses the producer's admitted signing mode: only the exact Universal ad-hoc
`INVALID_SIGNATURE` / `-67050` self and real-ZIP results can be recorded as
publisher acceptance unavailable. It still runs real ZIP extraction, hostile
archive refusals and cleanup, then ordinary application acceptance. Thin and
persistent-validation packages require successful publisher acceptance; all
unexpected results fail. Production update verification is unchanged.
The subsequent normal CI results above establish ordinary Universal acceptance.

This source increment passes strict typing, the normal application/shared-UI
build and 1,236 tests in 18.42 seconds:
1,278 total, zero failures and 42 explicit native/opt-in skips. These source
checks are separate from actual packaged Mac acceptance.

### Earlier fixture checkpoint

Both thin Mac jobs and universal construction in
[CI 37886541728](https://github.com/juferdinand/OpenWhisper/actions/runs/37886541728)
pass at actual synthetic producer `7ae341fb`, distinct from API head `bd1b1b75`.
The actual literal-filename regression passes on ARM and Intel (1.06 and 5.58
seconds), followed by original Dev Quit and stable restart/Quit. The constructor
retains all source, native, minimum-OS, signing and ZIP gates. Both universal
consumers pass their preceding checksum/extract/producer checks, then stop before
app launch because the public `jfk.wav` fixture is absent. The enclosing Actions
artifact digest is not the unprinted inner ZIP SHA; no native runtime success
is inferred from that failure.

Fixture preparation now obtains the existing pinned speech source only when
the sample is missing, without a compiler or app build. One independently
reviewed cold private preparation passes in 1.30 seconds with exact model/WAV/
Float32 checksums, original normal process closure and no native build outputs.
The following normal CI results above supersede that missing-fixture boundary.

The inactive Debian installed-target audit now authenticates the original
download, reads a bounded inventory through the maintained typed archive
library, and compares fixed physical installed files, ownership, modes and
package status. Its private closure retains the authenticated version and
source; it accepts no replacement root or manifest from the GUI. Independent
review fixes mutable-input capture and categorical tool errors. Thirteen
portable cases pass. One explicit Ubuntu 22.04 container case authenticates
original signed 0.2.5 bytes and refuses its 61 MB native launcher at the
bounded Electron-script inventory limit. That case does not prove a current
signed Electron inventory or a root-owned installed success. Installation,
main/UI activation and restart remain unconnected. Both packagers retain
the pinned library dependency closure and required license notice.

This source checkpoint passes strict typing, the normal application/shared-UI
build, and 1,230 tests in 18.55 seconds: zero failures and 42 explicit native/
opt-in skips (1,272 total). Earlier check counts below belong to their stated
historical checkpoints.

The unchanged clean `2ce4a228` supervised AppImage now passes all 18 runtime
checks in 64.59 seconds. Its permanent image, extracted resources and original
supervisor/GUI chains are admitted; CLI control, CPU recognition, clipboard,
Retry/Discard, native X11, autostart and generated-target restarts pass. Three
original launch chains exit normally, their PIDs/extractions disappear, and
private services and namespace close. Original package/source/mode comparisons
pass. Only the independently reviewed owned X11 environment changes:
`LP_NUM_THREADS=2`, matching the existing KDE rendering budget. The task cap
stays 256. Actual peak/events are not recorded in this passing normal mode;
no lower measured task count is claimed. The earlier case remains a separate
failure: GLib could not create its `gdbus` thread and four limit rejections were
recorded. This corrects the test environment, not the production package.

Original [CI 37884060187](https://github.com/juferdinand/OpenWhisper/actions/runs/37884060187)
passes both thin Mac Dev/Stable jobs at actual producer `6776c53c`, distinct from
API head `1524f150`. Universal verification identifies `Electron Helper (GPU)`.
The file is read and its Mach-O header checked before `otool`; Apple's default
archive-member syntax then misinterprets its final `(GPU)` as a member name.
The reviewed correction adds `-m` while retaining the exact path and all native,
minimum-OS, signing and source gates. See the [Apple tool documentation](https://github.com/apple-oss-distributions/cctools/blob/e0d56624eca2a76c2ace4c21850df9e666de4ca5/man/otool-classic.1#L188).
A Darwin regression copies a real Mach-O into the exact helper filename and
calls production inspection without executing it. That case is explicitly
skipped under Linux; actual universal success remains pending normal CI.

The next [normal CI 37885999655](https://github.com/juferdinand/OpenWhisper/actions/runs/37885999655)
fails an additional legacy-tool comparison at its separate five-second startup
bound on Intel, before calling the corrected production helper. That redundant
negative invocation is removed; the owned real-file positive regression and
production tool policy remain intact. Six focused cases and strict typing pass,
with the actual Darwin case explicitly skipped on Linux. Universal confirmation
still requires the next normal CI; this test failure is not a `-m` product result.

The inactive AppImage consumer adds an installed-only continuation step. It
reauthenticates the fixed installed 0755 candidate without weakening private
0600 staged-file admission, writes a bounded private recovery hint, and closes
both original candidate/predecessor descriptors. The same parent can recheck
the installed candidate and roll back before a refused exec using new guarded
descriptors. The backup remains on disk; persisted records grant no automatic
rollback or execution authority. Six existing private-file cases pass at the
new production hash, followed by two corrected new cases with five refusal
variants. They use original signed 0.2.5 bytes, synthetic current 0.2.4 and an
inert predecessor on host Node; no image or exec runs. Bootstrap/installer/UI
activation and next-generation cleanup remain separate work.

The inactive release-metadata reader uses the fixed Linux feed or admitted Mac
repository API, limits response sizes and retains original pending work through
cancellation/closure. Linux redirects must keep the exact versioned `latest.json`
and agree with its body; Mac API redirects are refused. Existing model/artifact
transport policies are unchanged. Thirteen focused checks and independent review
pass. Two actual read-only HTTPS requests project version 0.2.5 against synthetic
current 0.2.4; these candidates remain unauthenticated. No package download,
installer or UI update activation follows.

An inactive V2 parent/GUI channel adds bounded commands and public states on
the caller-owned duplex, bound to its current version and startup nonce. The
GUI supplies no candidate URL, path or installation authority. Parent retirement
requires its prepared version, explicit retirement request, matching acknowledgment
and clean original duplex closure. Original action settlement remains retained
through cancellation/disconnect. Callback-chained actions and blocked-write
closure have focused regressions. Bootstrap, native cleanup and installers are
not connected to this channel yet; V1 remains intact.

The combined reviewed increment passes TypeScript checks, the normal application
and shared-UI build, and 1,216 tests in 18.24 seconds: zero failures and 41
explicit native/opt-in skips (1,257 total). Workflow YAML and Bash syntax pass. These source
checks do not replace the separately identified immutable-package evidence.

Both original thin jobs in
[CI 37881571843](https://github.com/juferdinand/OpenWhisper/actions/runs/37881571843)
pass, confirming the preceding Intel fixture correction. API head `26e02ab0`
differs from actual synthetic package producer
`2bba516dc4c8a14acdbf66fdd7bd0d016a6edf67`. Clean-source admission passes and
the official universal merger runs. The first unsigned native verification then
fails at `/usr/bin/otool` exit 1. Its original path/stderr were not retained;
cause remains unclassified. No universal ZIP, final signing or universal runtime
passes. A reviewed bounded failure receipt now preserves the relative native
file, tool/category/status and sanitized stderr on the next normal constructor,
without changing gates or repeating the old run.

The earlier Linux failure remains narrower than a native bus-opening result:
the callback verifies/loads its addon before calling the native connection.
CPU inference is capped at eight threads. One independently reviewed diagnostic
uses the unchanged clean `2ce4a228` Debian package and 256-task limit. All 18
original runtime checks pass in 46.04 seconds, including CLI control, CPU
recognition, recovery, clipboard, X11, autostart and both original supervised
closures. The private namespace is removed and package inputs remain unchanged.
The separate native-open probe does not run because Start succeeds.

Twelve bounded snapshots record 208 tasks after readiness, 225 after Retry and
227 after the sampled Cancel operations. Peak usage reaches 255 of 256, with
no limit rejection. The supervisor remains at 13 threads and the GUI changes
from 38 to 39; sampled CLI identities disappear after close. This demonstrates
a small transient resource margin, without proving the earlier failure's cause
or absence of all leaks. [Issue #37](https://github.com/juferdinand/OpenWhisper/issues/37)
retains the earlier failure separately; no product fix or physical-device
coverage is claimed.

The reviewed Linux launch supervisor is now connected to Stable Debian's fixed
`/opt/openwhisper/openwhisper-launch`, its desktop/autostart paths and the native
0.2.5 compatibility entry. Stable AppRun uses the same compiled TypeScript
bootstrap; the permanent installed AppImage launcher remains byte-identical.
CLI control bypasses parent admission into the original early command parser.
Downloaded images without permanent admission retain ordinary GUI startup.
Restart requires complete receipt EOF, original GUI exit/close and separate
replacement authentication; the current bootstrap refuses every update restart.
No installer or main restart writer is activated. Eighteen focused supervisor
cases and eleven bootstrap/packaging cases pass; one host archive-tool case
skips. Independent review fixes exit-to-pipe closure and monotonic deadline
gaps. The combined source passes typing, normal app/shared-UI build and1198 tests
in17.66 seconds, with34 explicit native/opt-in skips and zero failures.

Fresh exact-clean `2ce4a228` Ubuntu22 packages now pass native ABI, archive,
notices, launcher and desktop checks. Their first supervised Debian runtime
passes nine checks, including actual GUI/supervisor ownership, fd3, CPU dictation,
recovery, clipboard/history, X11 and autostart. A later CLI Start fails with
`Session bus unavailable`; original Status had passed. The opening adapter
rejects before owner resolution. The namespace reaches its 256-process/thread
cap once; causation remains unproven and is tracked in
[issue #37](https://github.com/juferdinand/OpenWhisper/issues/37). Cleanup requests
ordinary app close without forced termination and closes private services;
the final per-PID successful-Quit assertion was not reached. This failed run is
retained separately from the passing diagnostic above. Its cause remains open.
The first supervised AppImage case separately reaches the same task cap; the
corrected owned-rendering verification above passes. Earlier immutable runtime
results remain separate producers.

The inactive AppImage consumer independently authenticates an adjacent private
copy, retains the exact predecessor and supports explicit commit or rollback.
Six opt-in checks use pinned original signed 0.2.5 bytes in a disposable home;
launch admission and filesystem faults are synthetic, and no image is executed.
A focused final fault check also passes completed-then-reported-failed rename
and publication. Foreign destinations survive, retained backups remain private,
and both owned descriptors close on terminal restoration failure. Independent
review passes. The combined source passes typing, app/shared-UI build and 1200
tests in 17.81 seconds, zero failures and 38 explicit skips. The same unchanged
six cases also pass in actual Electron 44.7.0 / Node 24.21.0, using the unchanged
historical Dev9 executable and a separately bundled fixture. Descriptor counts,
private stages and namespace cleanup pass. This proves adapter compatibility,
not packaged updater activation; installer/restart wiring remains inactive.

Original [CI 37879018935](https://github.com/juferdinand/OpenWhisper/actions/runs/37879018935)
passes ARM Dev/Stable checks at actual synthetic producer
`51952cfcf4c77a4d70cf8b54ccc503ff8bab5803` (API head `2ce4a228`). Intel reaches
the update-download timeout fixture, then exceeds its 12-minute job limit;
universal construction/runtime are skipped. A delayed-write reproduction
confirms that the fixture's total deadline can expire before its awaited sync
entry. Only this test changes: advance its mock clock after entry and settle
held effects in finally. Twelve focused cases pass, one cached-asset case
explicitly skips, and independent review passes. The original precise pending
subphase was not logged; subsequent CI still must confirm the correction.

Both original thin jobs in
[CI 37876878846](https://github.com/juferdinand/OpenWhisper/actions/runs/37876878846)
pass on Intel and ARM, confirming both preceding fixture corrections. API head
is `1708a1e2`; actual package producer is synthetic merge
`814a7faf96d46cad94c94a92afc866c717823d21`. Universal construction refuses
`development-build.modified` before staging or invoking the official merger.
No universal ZIP or native universal runtime is produced. The production native
builder's generated `macos-retirement/build-production/` directory was not
ignored; this fixed output is now ignored, while sources/pins remain tracked.
The original dirty-path list is unavailable, so it is not claimed as the sole
cause. CI now explicitly refuses any unexplained dirty source before the final
Stable build. The strict clean-source constructor gate stays intact; the next
normal CI must verify this correction and actual universal behavior.

Fresh clean `340dee3fb60cbf5abf6819553d9b575848919305` Ubuntu22 packages
retain their original source inventory. The 119,618,040-byte AppImage has
SHA-256 `40156f21310f03a06cd114217163586b2d355f3c209c86c0e1d94cd579341873`.
Its complete owned runtime passes eighteen checks in 74.44 seconds: actual
permanent-launch admission, read-only preservation of the legacy autostart
entry, explicit UI disable/enable, generated launcher/image restart, disabled
state across another restart, command control, native X11, CPU dictation,
clipboard/history, Retry/Discard and secondary resource survival. All three
original image/process chains exit normally and their private extraction trees
disappear. The first attempt failed a contradictory test seed; changing only
that seed produced this result with the same immutable package. Real login,
physical devices and update replacement remain separate.

Both original owned Mac jobs in
[CI 37873249720](https://github.com/juferdinand/OpenWhisper/actions/runs/37873249720)
pass Dev and stable ZIP/signature checks and normal original exits. API head is
`340dee3f`; the actual thin package producer is synthetic PR merge
`bcf527b8b1f51d5705a9b92b5cc664b2e77786b3`. The universal constructor now
uses exactly pinned official `@electron/universal` with common V2 metadata,
both locked Koffi variants and architecture-indexed original receipts. It
retains thin inputs, checks common bytes and both native slices, captures final
native hashes after signing and verifies the ZIP roundtrip. Portable fixture
tests and independent review are separate from the pending actual Darwin
construction and universal runtime.

The inactive Debian installer consumer authenticates the original private
download again, reads exact package/version/architecture through retained fd3,
and admits one fixed Polkit/dpkg transaction. Its eight checks pass in unchanged
Electron 44.7.0 / Node 24.21.0 with actual `dpkg-deb`; install effects remain
synthetic. No privileged install or restart took place. Application wiring,
post-native-cleanup restart and rollback remain open.

At `294a8955`, the combined source passes strict typing, the normal app/shared-UI
build and 1177 unit tests in 17.62 seconds, with zero failures and 34 explicit
native/opt-in skips. The separate eight-case embedded Debian check above has no
skips. Independent source reviews pass for both new consumers and the harness.

The next CI increment consumes both successful thin packages from the same run,
constructs one universal ZIP, then checks that identical ZIP on Intel and ARM.
It reuses the normal stable smoke for migration, settings, signatures, archives,
shortcuts, restart and original Quit, plus capture Configure/Close and CPU public
fixture inference without opening a microphone. This workflow and its explicit
V2/original-receipt admission are reviewed; actual universal results remain open.

Stable Debian packaging also retains `/usr/bin/openwhisper-desktop`, the restart
path captured by native 0.2.5. The fixed entry forwards to the permanent Electron
installation; Dev does not own it. Owned inert packaging checks pass, with the
actual native-to-Electron upgrade still outstanding.

The original Intel job in
[CI 37875160757](https://github.com/juferdinand/OpenWhisper/actions/runs/37875160757)
fails before packaging in an existing abort test's initial mock bind. Hosted
scheduling exceeds its unrelated 30-ms monotonic setup budget. That one logical
ordering test now uses the existing injected clock; fourteen focused cases pass.
Production deadlines and separate expiry tests are unchanged. The original ARM
job passes; the next original CI run must confirm the corrected Intel case.

That next Intel run passes the unit phase, then exposes a separate owned native
fixture assumption: its early channel-exit case requires the kernel process to
have stopped already. Retained native snapshots still report running; subsequent
same-owner full reap and cleanup succeed. The reviewed three-file test correction
keeps early admission false while preserving the actual kernel level and every
mandatory full-reap/close receipt. Twenty-one focused tests and typing pass;
production code and deadlines stay unchanged. Both matching original thin jobs
subsequently pass in CI37876878846; its separate construction refusal is recorded
above.

Earlier package checkpoints follow with their original producers and scopes.

[CI37862779046](https://github.com/juferdinand/OpenWhisper/actions/runs/37862779046)
passes all six jobs at clean `b892d861921fd51c6a1de2e35c987a0bd620ac9b`, including
the complete owned Mac jobs on Intel and Apple Silicon. Each Mac job passes the
signed Dev capture-close check and normal stable first launch, read-only migration,
shortcut setup/removal, edited-state restart and original clean exits. The Mac
migration worker uses an empty OS preference domain and synthetic host facts; this
does not establish persistent-signature or nonempty 0.2.5 preference transitions.

Fresh Ubuntu22 stable build8 and Dev build9 retain that exact clean source. The
Dev package passes its full owned X11 runtime in 43.96 seconds. Installed stable
passes all eighteen checks in 58.92 seconds: ordinary Debian installation,
migration, CPU dictation, clipboard/history, recovery, all CLI commands, autostart
enable/disable, read-only refresh and restart through the fixed permanent target.
The final restarted original PID exits 0, all owned servers close normally and the
container is removed. The earlier attempt hung at final Quit; this did not
reproduce with the same immutable package and bounded close observations. No
production fix was made, and the original failure remains unclassified. These
unsigned packages establish automated container acceptance, not a release, real
login-session launch or physical-device coverage.

The fixed-key Linux signature helper verifies real cached 0.2.5 Debian/AppImage
bytes and streams with independent Rust-oracle agreement. Electron 44.7.0 /
embedded Node 24.21.0 lacks native BLAKE2b-512, so the helper uses exactly pinned
TypeScript `@noble/hashes` for that digest and retains Node Ed25519 verification.
All nine cases pass in that actual runtime in 20.25 seconds, including both real
packages and payload/key/comment/version/mode/stream negatives. This uses the
same immutable Dev9 executable and a separate compiled helper fixture; it does
not establish packaged updater wiring. Original MIT notices are included by both
packagers. Updates remain inactive pending installation acceptance and application
wiring. The separate Mac signature adapter obtains the current running
application's designated requirement and checks all architectures, nested code
and strict sealed resources through Apple's APIs. Nine focused ownership/failure
checks and independent reviews pass. Both original owned Mac jobs in
[CI37865793116](https://github.com/juferdinand/OpenWhisper/actions/runs/37865793116)
pass actual self, different-identity, unsigned and tampered-resource cases for
both Dev and stable, including normal restart/clean exits. The PR run identifies
head `9af2ed04`; its normal checkout/package producer is merge `ad3262de` into
`68294863`. These thin ad-hoc cases do not establish persistent release signing.

The complete signature increment passes strict typing, the ordinary application/
shared-UI build and 1110 unit tests with zero failures and 26 explicit native or
opt-in skips in 17.30 seconds. Focused real-artifact checks and actual Electron
execution are separate from those skipped default-suite cases.

The next reviewed increment shares private original-file staging and HTTPS
resource ownership between update consumers. Positioned writes preserve the
Mac inherited descriptor's initial offset; cancellation waits for actual reads,
writes and original connections to settle. Linux verifies both copied original
packages, and an inert HTTPS transfer of real cached Debian bytes authenticates
through the retained file. One actual public HTTPS transfer through the default
production factory also passes on Node26: exact 21,152,538-byte 0.2.5 Debian,
fixed signature/version/SHA, original descriptor closure and complete private
stage removal in 1.52 seconds. This uses synthetic current version 0.2.4 and
establishes download compatibility rather than an upgrade or Electron-embedded
network execution. The Mac consumer uses fixed system bsdtar/plutil,
internal framework links, exact metadata/version and the existing running-app
signature requirement. Both original Mac jobs in
[CI37868932078](https://github.com/juferdinand/OpenWhisper/actions/runs/37868932078)
fail in extraction cleanup; Stable smoke is skipped. The subsequent ARM job in
[CI37870309345](https://github.com/juferdinand/OpenWhisper/actions/runs/37870309345)
identifies `real-package:REMOVE_TREE:ENOTEMPTY`. An equivalent failure is
reproduced in the unchanged Dev9 Electron runtime: normal `fs` treats the
physical `default_app.asar` file as a virtual directory and leaves it behind.
The built-in `original-fs` removes the owned tree successfully. The reviewed
consumer now uses physical filesystem operations for bundle checks and removal,
with no global ASAR switch or retry. Both original owned Mac jobs in
[CI 37871798972](https://github.com/juferdinand/OpenWhisper/actions/runs/37871798972)
pass Dev and stable ZIP roundtrips, all seven malformed-archive fixtures,
same-version refusal and original clean exits. Its API head is `f28b2583`; the
actual checkout/package producer is synthetic merge `7e30a4f7`. These thin
ad-hoc packages establish archive acceptance, with persistent publisher and
universal installation acceptance still outstanding.

The committed cleanup/signing/harness increment `6994e42` passes strict typing,
ordinary build and 1153 tests with 28 explicit skips in 17.83 seconds. Its thin
Mac persistent-validation signing mode is independently reviewed; actual
certificate/universal release signing remains outstanding. AppImage startup and
secondary activation/resource survival pass with a short private temporary base.
The earlier 125-byte Chromium socket path and restrictive font-cache mode check
are retained as diagnosed harness failures. The corrected full owned runtime
passes all 15 checks in 64.39 seconds: all five CLI command kinds and absent-owner
refusal, native X11 controls, real CPU recognition/clipboard/history, Retry/
Discard, edited-state restart, secondary resource survival and normal cleanup.
Both launcher/runtime/main chains exit normally, all observed PIDs are absent
and the extraction base is empty; actual cache mode is safely 0600. That
increment passes strict typing and 1153 default-suite tests in 17.88 seconds
with 28 explicit skips. Matching Mac ZIP execution subsequently passes as above.

The next source increment admits an AppImage launch only through the exact
permanent image and launcher, matching extracted layout, same-user live process
ancestry and original file identities. Startup/status reads preserve existing
autostart entries; explicit enable can retarget a recognized entry to the two
escaped permanent arguments. Focused admission tests use real owned files and
a mocked kernel boundary; a fresh package runtime must verify the new wiring.
The separate Mac V2 descriptor validates both architecture branches before
selecting the current runtime's V1 services. Thin/Linux V1 remains unchanged;
this is preparation for a universal package rather than proof of one. The
combined source passes strict typing, ordinary build and 1167 tests in 17.99
seconds, zero failures and 28 explicit skips.

Unsigned AppImage construction reuses the exact clean `b892d861` stable package.
The 119,441,912-byte image has SHA-256
`5307c99c5d8f603fbf8ed937d8688dc24181509163cdfc365552dd9bd5eb5069`;
passive extraction matches the payload/native descriptors, modes and notices.
The installed-launcher design creates private temporary storage before each
extract-and-run invocation, avoiding the upstream shared-directory cleanup race.
Owned application/control/restart acceptance passes with that exact old producer;
new permanent-path admission/autostart runtime and update wiring remain open. Raw overlapping
extract-and-run launches are outside this protected path.
Static runtime component notices are included, with LGPL corresponding-source/
relink obligations retained as a public distribution gate. Construction is not
signed-update or release acceptance. [Evidence](ELECTRON-DEV-EVIDENCE.md) keeps
the original failures and successful scopes separate.

## Delivery order and execution limits

Owner scope adjustment, 2026-10-08: finish the current genuine-X11 increment,
then defer expanded Linux desktop/special-input matrices to existing bug reports.
Basic dictation, controls and installation must work on both macOS and Linux.
Known basic-function failures still need correction. Prioritize the remaining
Mac composition and usable packages/update transition; keep untested desktop
claims and follow-up issues explicit instead of blocking on exhaustive coverage.
The original migration plan remains the architecture record; deferred coverage
is not a completed acceptance gate.

The complete 0.3.0 migration remains the objective. Deliver one runnable behavior
at a time. Regular KDE keyboard control is now checked against the owned stock
desktop, including active-binding Quit/crash recovery and insertion into native
Wayland and inner XWayland editors, with a separate genuine-X11 basic dictation pass. Reuse the
current desktop harness; do not build another general evidence framework.

Keep implementation and diagnosis rounds to about 30 minutes before reporting a
verified result or a concrete unresolved condition. End unproductive experiments
and continue independent migration work. Do not estimate overall completion as a
percentage. Run focused checks during development and the required full checks
once per completed increment. Reuse successful checks until relevant changes or
new failures justify repeating them. Observe the existing CI run rather than
dispatching replacements. Do not restart broad agent reviews; delegate only a
bounded task with a specific deliverable when it materially shortens delivery.

The measured bottleneck is implementation and fixture diagnosis, not normal test
execution: the current full unit suite takes about 18 seconds. Use
`npm run test:platform` and directly affected test files during development, then
one matching owned desktop scenario. Stock KDE no longer builds an unused synthetic
C++ portal. Its runner records command and total durations; the selected lifecycle
case passes in 10.58 seconds including assembly and cleanup. These measurements
do not imply that broader desktop or migration acceptance is complete.

Keep the installed stable application and the running Dev build unchanged until
the user accepts a replacement. Present runnable increments for acceptance before
merging functional changes.
