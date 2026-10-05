#!/bin/sh
# Paths are passed only as arguments, never as executable shell source.
set -eu

if [ "$#" -ne 4 ]; then
  echo "Expected process ID, current app, verified update, and staging directory" >&2
  exit 64
fi

process_id=$1
current_app=$2
updated_app=$3
staging_directory=$4
backup_app="$staging_directory/previous.app"

while kill -0 "$process_id" 2>/dev/null; do sleep 0.2; done

# Keep the previous app until its replacement has been moved successfully.
mv "$current_app" "$backup_app"
if ! mv "$updated_app" "$current_app"; then
  mv "$backup_app" "$current_app"
  open "$current_app" || true
  exit 1
fi

xattr -dr com.apple.quarantine "$current_app" 2>/dev/null || true
open "$current_app"
rm -rf "$staging_directory"
