#!/bin/sh
# Starts mDNS (for NDI discovery) as root, then runs BroadcastRelay as an ordinary user.
#   RUN_UID / RUN_GID   user the app runs as (default 1000:1000). It needs write access to /recordings.
#   NDI_AVAHI           auto (default): start Avahi in the container
#                       host: use the host's Avahi (mount /var/run/dbus from the host)
#                       off:  no mDNS (use an NDI Discovery Server)
set -e
RUN_UID="${RUN_UID:-1000}"
RUN_GID="${RUN_GID:-1000}"

if [ -x /usr/local/bin/ndi-bridge ] && [ "${NDI_AVAHI:-auto}" = "auto" ]; then
  mkdir -p /run/dbus
  rm -f /run/dbus/pid /run/avahi-daemon/pid 2>/dev/null || true
  if dbus-daemon --system --fork 2>/dev/null; then
    avahi-daemon --daemonize --no-chroot --no-drop-root -f /etc/broadcastrelay/avahi-daemon.conf 2>/dev/null \
      || echo "Avahi did not start: NDI discovery may not work. Use an NDI Discovery Server, or NDI_AVAHI=host."
  else
    echo "D-Bus did not start: NDI discovery may not work."
  fi
elif [ "${NDI_AVAHI:-auto}" = "host" ] && [ ! -S /run/dbus/system_bus_socket ] && [ ! -S /var/run/dbus/system_bus_socket ]; then
  echo "NDI_AVAHI=host, but the host's D-Bus socket is not mounted at /var/run/dbus."
fi

mkdir -p "${DATA_DIR:-/data}" "${RECORD_DIR:-/recordings}"
chown "$RUN_UID:$RUN_GID" "${DATA_DIR:-/data}" 2>/dev/null || true
# a new, empty recordings folder can be taken over; an existing dataset keeps its owner and ACLs
if [ -z "$(ls -A "${RECORD_DIR:-/recordings}" 2>/dev/null)" ]; then chown "$RUN_UID:$RUN_GID" "${RECORD_DIR:-/recordings}" 2>/dev/null || true; fi
export HOME="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups node /app/server.js "$@"
fi
exec node /app/server.js "$@"
