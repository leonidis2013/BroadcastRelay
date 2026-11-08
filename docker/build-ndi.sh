#!/bin/sh
# Downloads the NDI SDK and builds ndi-bridge into /out. Used by the Dockerfile.
# Running this means accepting the NDI SDK license (https://ndi.video).
# If anything fails, the image is built without NDI (the web page then says so) instead of failing.
set -u
mkdir -p /out/lib /out/bin /out/licenses
[ "${WITH_NDI:-1}" = "1" ] || { echo "NDI: skipped (WITH_NDI=${WITH_NDI})"; exit 0; }

# Every step is chained with && or checked: "set -e" does not work inside "if ! (build)".
build() {
  cd /build || return 1
  curl -fsSL "$NDI_SDK_URL" -o sdk.tgz && tar xzf sdk.tgz || return 1
  installer="$(ls -1 Install_NDI_SDK_*_Linux.sh | head -1)"
  [ -n "$installer" ] || { echo "NDI: no installer in the download"; return 1; }
  yes | PAGER=cat sh "./$installer" > /dev/null
  sdk="$(ls -d NDI\ SDK\ for\ Linux* | head -1)"
  [ -d "$sdk/include" ] || { echo "NDI: the installer did not unpack the SDK"; return 1; }
  case "$TARGETARCH" in
    amd64) dirs="x86_64-linux-gnu" ;;
    arm64) dirs="aarch64-linux-gnu aarch64-rpi4-linux-gnueabi aarch64-rpi5-linux-gnueabi" ;;
    *) echo "NDI: unsupported architecture $TARGETARCH"; return 1 ;;
  esac
  libdir=""
  for d in $dirs; do if [ -d "$sdk/lib/$d" ]; then libdir="$sdk/lib/$d"; break; fi; done
  if [ -z "$libdir" ]; then echo "NDI: no library folder for $TARGETARCH. The SDK has:"; ls "$sdk/lib"; return 1; fi
  lib="$libdir/libndi.so.6"
  [ -e "$lib" ] || lib="$(ls -1 "$libdir"/libndi.so* | head -1)"
  cp -L "$lib" /out/lib/libndi.so.6 || return 1
  # libndi needs Avahi's client libraries (installed in this stage) to link
  gcc -O2 -Wall -I"$sdk/include" ndi-bridge.c -o /out/bin/ndi-bridge /out/lib/libndi.so.6 -lpthread -Wl,-rpath,/usr/local/lib || return 1
  [ -x /out/bin/ndi-bridge ] || { echo "NDI: ndi-bridge was not built"; return 1; }
  cp -r "$sdk/licenses/." /out/licenses/ 2>/dev/null || true
  cp "$sdk"/*.pdf /out/licenses/ 2>/dev/null || true
  echo "NDI: built ndi-bridge with $(basename "$lib") from $libdir"
}

if ! (build); then
  echo "############################################################"
  echo "WARNING: the NDI SDK step failed. Building WITHOUT NDI."
  echo "############################################################"
  rm -rf /out/lib/* /out/bin/*
fi
exit 0
