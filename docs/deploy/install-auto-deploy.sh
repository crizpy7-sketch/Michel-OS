#!/bin/sh
# Install the auto-deploy timer. Idempotent; safe to re-run after an update.
set -eu

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo sh install-auto-deploy.sh" >&2; exit 1; }
[ -f .env ] || { echo "docs/deploy/.env is missing." >&2; exit 1; }

if [ "$REPO_ROOT" != "/opt/michel-os" ]; then
  echo "NOTE: repo is at ${REPO_ROOT}, but the unit files assume /opt/michel-os." >&2
  echo "Edit the ExecStart/WorkingDirectory paths before installing." >&2
  exit 1
fi

install -m 0644 michel-auto-deploy.service /etc/systemd/system/michel-auto-deploy.service
install -m 0644 michel-auto-deploy.timer   /etc/systemd/system/michel-auto-deploy.timer

systemctl daemon-reload
systemctl enable --now michel-auto-deploy.timer

echo
echo "Installed. The timer checks origin/main every 3 minutes."
systemctl status michel-auto-deploy.timer --no-pager | sed -n '1,6p'
echo
echo "Watch a deploy:   journalctl -u michel-auto-deploy -f"
echo "Deploy right now: sh /opt/michel-os/docs/deploy/auto-deploy.sh --force"
echo "Stop auto-deploy: systemctl disable --now michel-auto-deploy.timer"
