/** The permanent launcher owns each invocation's separate extraction lifetime. */
export function appImageLauncher(): string {
  return ["#!/bin/sh", "set -eu", 'image=${1:?A permanent AppImage path is required}', "shift",
    'case "$image" in /*) ;; *) exit 64 ;; esac', 'test -f "$image" && test -x "$image" && test ! -L "$image" || exit 64',
    "umask 077", 'launch_tmp=$(mktemp -d "${TMPDIR:-/tmp}/openwhisper-appimage.XXXXXXXX")', "child=",
    'cleanup() { status=$?; trap - EXIT HUP INT TERM; rm -rf -- "$launch_tmp"; exit "$status"; }',
    'terminate() { trap "" HUP INT TERM; if test -n "$child"; then /bin/kill -TERM -- "-$child" 2>/dev/null || :; attempts=0; while /bin/kill -0 "$child" 2>/dev/null && test "$attempts" -lt 100; do sleep 0.1; attempts=$((attempts + 1)); done; /bin/kill -KILL -- "-$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; child=; fi; exit 143; }',
    "trap cleanup EXIT", "trap terminate HUP INT TERM", "unset TARGET_APPIMAGE APPIMAGE APPDIR ARGV0 NO_CLEANUP",
    'TMPDIR="$launch_tmp" APPIMAGE_EXTRACT_AND_RUN=1 setsid --wait "$image" "$@" &', "child=$!", "status=0",
    'wait "$child" || status=$?', "child=", 'exit "$status"', ""].join("\n");
}
