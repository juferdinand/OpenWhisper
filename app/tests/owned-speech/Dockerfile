FROM --platform=linux/amd64 ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils fonts-dejavu-core libgtk-3-0 libnss3 \
    libasound2 libgbm1 libatomic1 xvfb cmake ninja-build build-essential binutils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && printf '%s  %s\n' fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 /tmp/node.tar.xz | sha256sum -c - \
    && mkdir /opt/node && tar -xf /tmp/node.tar.xz --strip-components=1 -C /opt/node && rm /tmp/node.tar.xz \
    && useradd --create-home --uid 1000 tester \
    && mkdir /owned-app /fixtures /evidence && chown 1000:1000 /owned-app /fixtures /evidence \
    && dpkg-query -W > /etc/openwhisper-test-packages.txt
ENV PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000:1000
WORKDIR /owned-app
