#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
. ./lib.sh

# Read .env when it exists so the candidate port and project name match the
# real deployment rather than the defaults.
if [ -f .env ]; then
  michel_load_env
else
  MICHEL_PROJECT="${MICHEL_PROJECT:-michel-os}"
fi

PORT="${MICHEL_BIND_PORT:-3100}"

echo '== Michel OS shared-VPS preflight =='
echo "candidate Michel loopback port: ${PORT}"
echo

echo '-- MarketSwarm systemd state (if systemd-managed) --'
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active marketswarm 2>/dev/null || true
  systemctl status marketswarm --no-pager 2>/dev/null | sed -n '1,18p' || true
fi

echo
echo '-- Docker containers before Michel deployment --'
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true
else
  echo 'ERROR: Docker is required for Michel OS shared-VPS deployment.' >&2
  exit 2
fi

echo
echo '-- MarketSwarm persistent state --'
if [ -d /var/lib/marketswarm ]; then
  ls -ld /var/lib/marketswarm
else
  echo 'NOTE: /var/lib/marketswarm was not found; MarketSwarm may use another configured data directory.'
fi

echo
echo '-- Listening ports 80, 443, and Michel candidate --'
if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null | grep -E ":(80|443|${PORT})\\b" || true
fi

# A busy candidate port has two opposite meanings, and the difference decides
# what the operator should do next:
#
#   published by OUR OWN compose project -> Michel is already deployed here, so
#     this is a redeploy. `docker compose up` replaces its own container and
#     rebinds the port. Changing MICHEL_BIND_PORT here would be actively wrong:
#     it orphans the reverse-proxy config and leaves two copies running.
#
#   published by anything else -> a genuine collision. Stop.
#
# Reporting the first case as a hard error made a routine upgrade look like a
# blocked first install, so the check now identifies the owner before judging.
# 80/443 may legitimately belong to the existing reverse proxy either way.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -Eq "(^|[[:space:]])[^[:space:]]*:${PORT}[[:space:]]"; then
  if michel_owns_port "$PORT"; then
    echo
    echo "NOTE: port ${PORT} is published by this deployment's own project (${MICHEL_PROJECT})."
    echo 'Michel OS is already running here — this is an upgrade, not a first install.'
    echo 'Do NOT change MICHEL_BIND_PORT; compose replaces its own container in place.'
  else
    echo "ERROR: port ${PORT} is in use by something that is not Michel OS." >&2
    echo 'Set MICHEL_BIND_PORT to a free loopback port and point the reverse proxy at it.' >&2
    exit 3
  fi
fi

echo
echo '-- Host capacity --'
df -h / || true
free -h 2>/dev/null || true

echo
echo 'PASS: preflight found no Michel port collision.'
echo 'This script does not modify, stop, restart, or expose MarketSwarm.'
