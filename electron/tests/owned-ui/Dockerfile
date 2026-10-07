# Package provisioning is container-only; all tests and Electron run as UID 1000.
FROM --platform=linux/amd64 debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils fonts-dejavu-core \
    libgtk-3-0t64=3.24.49-3 libnss3=2:3.110-1+deb13u4 \
    libasound2t64=1.2.14-1+deb13u1 libgbm1=25.0.7-2+deb13u1 \
    libatomic1=14.2.0-19 xvfb=2:21.1.16-1.3+deb13u4 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && printf '%s  %s\n' fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 /tmp/node.tar.xz | sha256sum -c - \
    && mkdir /opt/node && tar -xf /tmp/node.tar.xz --strip-components=1 -C /opt/node \
    && rm /tmp/node.tar.xz \
    && useradd --create-home --uid 1000 tester \
    && mkdir /owned-app /evidence && chown 1000:1000 /owned-app /evidence \
    && dpkg-query -W > /etc/openwhisper-test-packages.txt
ENV PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000:1000
WORKDIR /owned-app
