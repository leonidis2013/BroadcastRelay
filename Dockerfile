# BroadcastRelay: OBS / NDI in -> YouTube, Facebook, RTMP/SRT, web player, NDI out, recording
#
# Build arguments you might change:
#   MEDIAMTX_VERSION  MediaMTX release (github.com/bluenviron/mediamtx)
#   HLSJS_VERSION     hls.js for the web player on browsers without native HLS
#   WITH_NDI          1 = download the NDI SDK and build ndi-bridge. Building with NDI means you
#                     accept the NDI SDK license (ndi.video). 0 = an image without NDI.

ARG MEDIAMTX_VERSION=1.19.0
ARG HLSJS_VERSION=1.6.15
ARG WITH_NDI=1

# ---------- NDI helper ----------
FROM debian:bookworm-slim AS ndi
ARG TARGETARCH
ARG WITH_NDI
ARG NDI_SDK_URL=https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v6_Linux.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev libavahi-client3 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY ndi/ndi-bridge.c docker/build-ndi.sh ./
RUN TARGETARCH="$TARGETARCH" WITH_NDI="$WITH_NDI" NDI_SDK_URL="$NDI_SDK_URL" sh ./build-ndi.sh

# ---------- the app ----------
FROM node:22-bookworm-slim
ARG TARGETARCH
ARG MEDIAMTX_VERSION
ARG HLSJS_VERSION

# ffmpeg: the encoders and meters. avahi + dbus: NDI discovery (mDNS). util-linux has setpriv.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl tzdata avahi-daemon libavahi-client3 dbus util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar xz -C /usr/local/bin mediamtx; \
    /usr/local/bin/mediamtx --version

COPY --from=ndi /out/lib/ /usr/local/lib/
COPY --from=ndi /out/bin/ /usr/local/bin/
COPY --from=ndi /out/licenses/ /usr/share/doc/ndi/
RUN ldconfig

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN set -eux; mkdir -p public/vendor /tmp/hls; \
    curl -fsSL "https://registry.npmjs.org/hls.js/-/hls.js-${HLSJS_VERSION}.tgz" | tar xz -C /tmp/hls package/dist/hls.min.js; \
    mv /tmp/hls/package/dist/hls.min.js public/vendor/hls.min.js; rm -rf /tmp/hls
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/avahi-daemon.conf /etc/broadcastrelay/avahi-daemon.conf
RUN chmod +x /entrypoint.sh && mkdir -p /data /recordings

ENV NODE_ENV=production \
    DATA_DIR=/data \
    RECORD_DIR=/recordings \
    PORT=9180 \
    PUBLIC_PORT=9181 \
    MEDIAMTX=/usr/local/bin/mediamtx \
    NDI_BRIDGE=/usr/local/bin/ndi-bridge

# settings, sign-ins and keys live in /data (a named volume); recordings in /recordings (a dataset)
VOLUME /data
# 9180 control page, 9181 web player, 1935 RTMP, 8889 WHIP/WebRTC, 8890/udp SRT, 8189/udp WebRTC media
EXPOSE 9180 9181 1935 8889 8890/udp 8189/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9180)+'/player.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
