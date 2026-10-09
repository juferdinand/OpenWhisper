# Rebuilding and relinking the AppImage runtime

This file is bundled as
`usr/lib/openwhisper/notices/AppImage-runtime-components/source/RELINKING.md`.
The source archives and `source-manifest.json` are beside it; their hashes are
also recorded in the parent
`usr/lib/openwhisper/notices/AppImage-runtime-components/manifest.json`.
The pinned `type2-runtime` source includes the Docker build context and the
patch applied to statically linked libfuse 3.15.0.

On an x86_64 Linux host with Docker, Git, `patch`, `squashfs-tools` (`mksquashfs`),
and `appimagetool` available, set `IMAGE` to the AppImage being relinked,
extract it, and run these commands from the directory containing
`squashfs-root`:

```sh
set -eu
IMAGE="./OpenWhisper-Linux-x86_64.AppImage" # use the exact stable or development image filename
"$IMAGE" --appimage-extract
SOURCE=""
for APP_DIR in "$PWD/squashfs-root/usr/lib/openwhisper" "$PWD/squashfs-root/usr/lib/openwhisper-dev"; do
  if test -d "$APP_DIR/notices/AppImage-runtime-components/source"; then
    SOURCE="$APP_DIR/notices/AppImage-runtime-components/source"
    break
  fi
done
test -d "$SOURCE"
sha256sum --check <<EOF
f5fec23be76e50e2445ed2d018bac49b367490fc483c62c4637e99ec705d27ba  $SOURCE/type2-runtime-dd6cebedcbddde9c82f89b011e8e1d40b6e43868.tar.gz
70589cfd5e1cff7ccd6ac91c86c01be340b227285c5e200baa284e401eea2ca0  $SOURCE/fuse-3.15.0.tar.xz
db0238c5981dabbd80ee09ae15387f390091668ca060a7bc38047912491443d3  $SOURCE/squashfuse-0.5.2.tar.gz
1c7fd9e26717545a476b226b083a9f9d05676c180edbd71a04bbd8a73599dc44  $SOURCE/mount.c.diff
EOF

WORK="$PWD/runtime-relink-work"
mkdir -m 700 "$WORK"
tar -xzf "$SOURCE/type2-runtime-dd6cebedcbddde9c82f89b011e8e1d40b6e43868.tar.gz" -C "$WORK"
RT="$WORK/type2-runtime-dd6cebedcbddde9c82f89b011e8e1d40b6e43868"
FUSE="$WORK/fuse-3.15.0"
mkdir "$FUSE"
tar -xJf "$SOURCE/fuse-3.15.0.tar.xz" -C "$FUSE" --strip-components=1
cd "$FUSE"
git init -q
git add .
git -c user.name=AppImageRelink -c user.email=local.invalid commit -qm pristine
patch -p1 < "$SOURCE/mount.c.diff"

# Edit libfuse source files here. Save all changes before generating the patch.
git diff --binary HEAD > "$RT/patches/libfuse/mount.c.diff"
cd "$RT"
ARCH=x86_64 bash scripts/docker/build-with-docker.sh
```

The generated patch replaces the patch in the runtime repository's Docker
build context. Its Dockerfile copies `patches/` into the image, and
`install-dependencies.sh` applies that patch to the clean checksum-pinned
libfuse source before compiling it. The builder therefore includes the user's
libfuse edits; editing the extracted source alone would not affect its build.
The upstream `scripts/build-runtime.sh` writes the rebuilt runtime at
`runtime-relink-work/type2-runtime-dd6cebedcbddde9c82f89b011e8e1d40b6e43868/runtime-x86_64`.

To recreate the image from the extracted payload, run from the directory
containing `squashfs-root` (the output can have any local filename):

```sh
./appimagetool-x86_64.AppImage --no-appstream \
  --runtime-file runtime-relink-work/type2-runtime-dd6cebedcbddde9c82f89b011e8e1d40b6e43868/runtime-x86_64 \
  --comp zstd squashfs-root OpenWhisper-relinked.AppImage
```

The upstream Dockerfile names Alpine 3.21 but does not pin its image digest or
APK package revisions. This recipe provides a relinking path for modified
libfuse; it does not claim a byte-identical rebuild or attest exact versions
of the other static libraries in the supplied runtime.
