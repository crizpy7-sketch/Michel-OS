#!/bin/sh
# Bounded operator-invoked rollback. This is intentionally not automatic: an
# operator supplies and confirms one exact commit, and backup/provenance gates
# must all pass before the deployed stamp can move.
set -eu

cd "$(dirname "$0")"
. ./lib.sh
REPO_ROOT="$(cd ../.. && pwd)"

[ "${1:-}" = "--rollback-to" ] && [ -n "${2:-}" ] || {
  echo "Usage: sh manual-rollback.sh --rollback-to <exact-40-char-sha>" >&2; exit 2;
}
ROLLBACK="$(michel_require_git_commit "$REPO_ROOT" "$2")" || {
  echo "Rollback target must be an exact commit available in this repository" >&2; exit 1;
}
[ "${MICHEL_ROLLBACK_CONFIRM:-}" = "$ROLLBACK" ] || {
  echo "Set MICHEL_ROLLBACK_CONFIRM=$ROLLBACK to authorize this bounded rollback" >&2; exit 1;
}

michel_load_env
HEALTH_URL="http://127.0.0.1:${MICHEL_BIND_PORT:-3100}/api/ready"
STAMP="${REPO_ROOT}/.swarm/deployed-sha"
CURRENT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] || {
  echo "Tracked working tree changes block rollback" >&2; exit 1;
}

# Backup is the first mutating precondition. If it fails, checkout/build never run.
sh ./backup.sh || { echo "Backup failed; rollback refused" >&2; exit 1; }

rollback_failed() {
  echo "Rollback candidate failed; restoring previous checkout/runtime without stamping" >&2
  git -C "$REPO_ROOT" checkout --quiet --detach "$CURRENT" || true
  export MICHEL_RELEASE_SHA="$CURRENT"
  michel_compose up -d --build || true
  exit 1
}
trap rollback_failed HUP INT TERM

git -C "$REPO_ROOT" checkout --quiet --detach "$ROLLBACK" || rollback_failed
export MICHEL_RELEASE_SHA="$ROLLBACK"
michel_compose up -d --build || rollback_failed

READY_BODY=''; i=0
while [ "$i" -lt 30 ]; do
  READY_BODY="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  [ -n "$READY_BODY" ] && break
  i=$((i + 1)); sleep 2
done
[ -n "$READY_BODY" ] || rollback_failed
READY_SHA="$(michel_readiness_release_sha "$READY_BODY" || true)"
IMAGE_SHA="$(michel_running_image_revision || true)"
michel_reconcile_release "$ROLLBACK" "$READY_SHA" "$IMAGE_SHA" || rollback_failed
michel_write_deployed_stamp "$ROLLBACK" "$READY_SHA" "$IMAGE_SHA" "$STAMP" || rollback_failed
trap - HUP INT TERM
echo "[manual-rollback] PASS rollback=$ROLLBACK"
