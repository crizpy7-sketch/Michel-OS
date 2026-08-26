#!/usr/bin/env sh
set -eu

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

# Refuse to start Michel when the candidate loopback port is already occupied.
# 80/443 may legitimately be occupied by the existing reverse proxy.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -Eq "(^|[[:space:]])[^[:space:]]*:${PORT}[[:space:]]"; then
  echo "ERROR: port ${PORT} is already in use. Set MICHEL_BIND_PORT to a free loopback port." >&2
  exit 3
fi

echo
echo '-- Host capacity --'
df -h / || true
free -h 2>/dev/null || true

echo
echo 'PASS: preflight found no Michel port collision.'
echo 'This script does not modify, stop, restart, or expose MarketSwarm.'
