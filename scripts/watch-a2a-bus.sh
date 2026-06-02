#!/usr/bin/env bash
# Live-tail every $a2a/v1/* topic on the local EMQX broker. Use for E8 testing.
#
# Connects as the host-singleton (paperclip-server) which has wildcard
# subscribe ACL on $a2a/v1/#.
#
# Usage: ./scripts/watch-a2a-bus.sh
#        ./scripts/watch-a2a-bus.sh '$a2a/v1/event/#'   # narrow filter
#        ./scripts/watch-a2a-bus.sh '$a2a/v1/request/#'

set -euo pipefail

TOPIC="${1:-\$a2a/v1/#}"
HOST="${PAPERCLIP_MQTT_HOST:-localhost}"
PORT="${PAPERCLIP_MQTT_PORT:-1883}"
USER="${PAPERCLIP_MQTT_HOST_USERNAME:-paperclip-server}"
PASS="${PAPERCLIP_MQTT_HOST_PASSWORD:-paperclip-host-dev}"

if ! command -v mosquitto_sub > /dev/null; then
  echo "mosquitto_sub not installed. brew install mosquitto OR use docker:"
  echo "  docker exec -it paperclip-emqx /opt/emqx/bin/emqx_ctl trace traces"
  exit 1
fi

echo "Subscribing to ${TOPIC} on ${HOST}:${PORT} as ${USER}..."
echo "Ctrl-C to stop."
echo ""

exec mosquitto_sub \
  -h "${HOST}" \
  -p "${PORT}" \
  -u "${USER}" \
  -P "${PASS}" \
  -t "${TOPIC}" \
  -v \
  -F '@H:@M:@S  %t  | %p'
