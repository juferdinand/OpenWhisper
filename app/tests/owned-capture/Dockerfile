FROM sha256:3031f986bb255608939c32b3929435c929efb4ce9be398786e369b1111d73431
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    pipewire pipewire-pulse wireplumber pulseaudio-utils libpulse0 dbus \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /capture-source /capture-test /evidence \
    && chown 1000:1000 /capture-source /capture-test /evidence \
    && dpkg-query -W > /etc/openwhisper-capture-packages.txt
USER 1000:1000
WORKDIR /capture-test
