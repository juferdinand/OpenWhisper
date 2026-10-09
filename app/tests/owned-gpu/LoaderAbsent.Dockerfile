ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0:0
# Deliberate disposable test image fault. The copied Electron loader is removed separately.
RUN rm -f /usr/lib/x86_64-linux-gnu/libvulkan.so /usr/lib/x86_64-linux-gnu/libvulkan.so.* \
          /lib/x86_64-linux-gnu/libvulkan.so /lib/x86_64-linux-gnu/libvulkan.so.*
USER 1000:1000
WORKDIR /owned-app
