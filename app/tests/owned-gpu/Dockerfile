ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0:0
# Provisioning only. Application/model execution happens later with network disabled as UID1000.
RUN apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2 update \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2 install -y --no-install-recommends \
       libvulkan-dev mesa-vulkan-drivers vulkan-tools \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg-query -W > /etc/openwhisper-gpu-test-packages.txt
USER 1000:1000
WORKDIR /owned-app
