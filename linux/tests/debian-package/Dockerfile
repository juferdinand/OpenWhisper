# Put an Ubuntu-built CI/release package named package.deb in the build context.
# Never substitute a binary linked against the development host's newer glibc.
FROM debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
COPY package.deb /tmp/openwhisper.deb
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y /tmp/openwhisper.deb python3-gi gir1.2-atspi-2.0 at-spi2-core libglib2.0-bin dbus-x11 xvfb xauth pipewire pipewire-pulse wireplumber pulseaudio-utils libasound2-plugins && rm -rf /var/lib/apt/lists/* /tmp/openwhisper.deb
ENV WF_OWNED_PACKAGE_CONTAINER=1
