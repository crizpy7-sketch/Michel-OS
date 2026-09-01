#!/bin/sh
# One-time handoff from the legacy timer to the first exact-SHA gated release.
# Run --freeze-legacy-timer before merging. Run the deployment mode only from
# an isolated worktree whose HEAD is the final, CI/QG-approved origin/main SHA.
set -eu

cd "$(dirname "$0")"
. ./lib.sh

TOOL_ROOT="$(cd ../.. && pwd)"
PRODUCTION_ROOT="${MICHEL_PRODUCTION_ROOT:-/opt/michel-os}"
BASELINE="50403bcd52425d3f49788905ebd81962647e2d39"
TIMER="michel-auto-deploy.timer"
SERVICE="michel-auto-deploy.service"

log() { echo "[bootstrap-gated-release] $*"; }
fail() { echo "[bootstrap-gated-release] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"

timer_frozen() {
  ! systemctl is-active --quiet "$TIMER" &&
    ! systemctl is-enabled --quiet "$TIMER" &&
    ! systemctl is-active --quiet "$SERVICE"
}

if [ "${1:-}" = "--freeze-legacy-timer" ]; then
  # Never terminate a deployment already in progress. Stop future ticks, then
  # require the current service to be inactive before declaring the freeze.
  systemctl disable --now "$TIMER" || fail "could not disable and stop legacy timer"
  systemctl is-active --quiet "$SERVICE" &&
    fail "deployment service is active; wait for it to finish and freeze again before merging"
  timer_frozen || fail "timer is not both disabled and inactive"
  log "FROZEN: legacy timer disabled/inactive; production was not deployed"
  exit 0
fi

TARGET=""
QUALITY_RECEIPT=""
RESTORE_EVIDENCE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --quality-receipt) QUALITY_RECEIPT="${2:-}"; shift 2 ;;
    --restore-evidence) RESTORE_EVIDENCE="${2:-}"; shift 2 ;;
    *) fail "unknown or incomplete argument: $1" ;;
  esac
done
[ -n "$TARGET" ] && [ -n "$QUALITY_RECEIPT" ] && [ -n "$RESTORE_EVIDENCE" ] ||
  fail "usage: bootstrap-gated-release.sh --target <sha> --quality-receipt <file> --restore-evidence <file>"

timer_frozen || fail "legacy timer/service must be disabled and inactive before bootstrap"
[ -d "$PRODUCTION_ROOT/.git" ] || fail "production repository not found: ${PRODUCTION_ROOT}"
[ -z "$(git -C "$PRODUCTION_ROOT" status --porcelain --untracked-files=no)" ] ||
  fail "production repository has tracked changes"

TARGET="$(michel_require_git_commit "$TOOL_ROOT" "$TARGET")" || fail "target is not the exact tool-worktree commit"
TOOL_HEAD="$(michel_require_git_commit "$TOOL_ROOT" "$(git -C "$TOOL_ROOT" rev-parse HEAD)")" || fail "invalid tool worktree"
[ "$TOOL_HEAD" = "$TARGET" ] || fail "bootstrap tool worktree HEAD must equal the deployment target"

git -C "$PRODUCTION_ROOT" fetch --quiet origin main || fail "could not fetch origin/main"
MAIN_SHA="$(git -C "$PRODUCTION_ROOT" rev-parse origin/main)"
MAIN_SHA="$(michel_require_git_commit "$PRODUCTION_ROOT" "$MAIN_SHA")" || fail "origin/main is not an exact commit"
[ "$MAIN_SHA" = "$TARGET" ] || fail "target must equal final origin/main; merge SHA substitution requires new evidence and approval"

LIVE_GIT="$(git -C "$PRODUCTION_ROOT" rev-parse HEAD)"
LIVE_GIT="$(michel_normalize_release_sha "$LIVE_GIT")" || fail "current live Git identity is invalid"
DEPLOYED="$(cat "$PRODUCTION_ROOT/.swarm/deployed-sha" 2>/dev/null || true)"
DEPLOYED="$(michel_normalize_release_sha "$DEPLOYED")" || fail "current deployed-sha is missing or invalid"
[ "$LIVE_GIT" = "$BASELINE" ] || fail "live Git SHA is not the approved production baseline"
[ "$DEPLOYED" = "$BASELINE" ] || fail "deployed SHA is not the approved production baseline"

cd "$PRODUCTION_ROOT/docs/deploy"
. ./lib.sh
michel_load_env
APP_CONTAINER="$(michel_compose ps -q app 2>/dev/null)"
DB_CONTAINER="$(michel_compose ps -q db 2>/dev/null)"
[ -n "$APP_CONTAINER" ] && [ -n "$DB_CONTAINER" ] || fail "Michel app/database containers are missing"
for container in "$APP_CONTAINER" "$DB_CONTAINER"; do
  [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" = true ] || fail "container is not running"
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null)" = healthy ] ||
    fail "container is not healthy"
done
michel_compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null || fail "database pg_isready failed"
michel_compose exec -T db psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'select 1' | grep -qx 1 ||
  fail "database query health failed"
HEALTH_URL="http://127.0.0.1:${MICHEL_BIND_PORT:-3100}/api/ready"
curl -fsS --max-time 3 "$HEALTH_URL" | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' || fail "production readiness baseline failed"

# Return to the trusted target worktree helpers for evidence admission.
cd "$TOOL_ROOT/docs/deploy"
. ./lib.sh
QUALITY_DIGEST="$(michel_file_sha256 "$QUALITY_RECEIPT")" || fail "Quality receipt missing"
RESTORE_DIGEST="$(michel_file_sha256 "$RESTORE_EVIDENCE")" || fail "restore evidence missing"
michel_validate_quality_receipt "$QUALITY_RECEIPT" "$TARGET" "$QUALITY_DIGEST" ||
  fail "Quality Gate receipt is not an integrity-checked PASS for the exact target"
michel_validate_real_backup_restore_evidence "$RESTORE_EVIDENCE" "$RESTORE_DIGEST" ||
  fail "successful real-production-backup isolated restore evidence is missing"

APPROVAL="$PRODUCTION_ROOT/.swarm/deploy-approval.json"
CLAIMED_APPROVAL="$PRODUCTION_ROOT/.swarm/deploy-approval.claimed.json"
USED_APPROVAL="$PRODUCTION_ROOT/.swarm/deploy-approval.used.json"
michel_validate_bootstrap_approval "$PRODUCTION_ROOT" "$TARGET" "$APPROVAL" "$QUALITY_DIGEST" "$RESTORE_DIGEST" ||
  fail "missing exact bootstrap approval or evidence binding"

michel_load_env_from_production() {
  cd "$PRODUCTION_ROOT/docs/deploy"
  . ./lib.sh
  michel_load_env
}

# GitHub is independently queried after approval/evidence validation. CI alone
# reaches this point but can never authorize it.
michel_load_env_from_production
michel_check_ci "$PRODUCTION_ROOT" "$TARGET" || fail "no successful exact-target gauntlet exists"
APPROVED_SHA="$(michel_read_deploy_approval_sha "$APPROVAL" approved)" || fail "approval receipt became unreadable"
michel_bootstrap_preflight "$BASELINE" "$TARGET" "$MAIN_SHA" "$LIVE_GIT" "$DEPLOYED" \
  false false false "$APPROVED_SHA" pass pass pass || fail "bootstrap policy preflight rejected observed state"

STATE="$PRODUCTION_ROOT/.swarm/bootstrap-gated-release.json"
write_state() {
  state="$1"; detail="$2"
  mkdir -p "$(dirname "$STATE")"
  temporary="${STATE}.tmp.$$"
  node - "$temporary" "$TARGET" "$BASELINE" "$state" "$detail" <<'NODE'
const fs = require('node:fs');
const [path, targetSha, baselineSha, state, detail] = process.argv.slice(2);
fs.writeFileSync(path, `${JSON.stringify({schemaVersion:'1.0.0', kind:'gated-release-bootstrap',
  targetSha, baselineSha, state, detail, observedAt:new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}, null, 2)}\n`, {mode:0o600});
NODE
  mv "$temporary" "$STATE"
}

rollback_baseline() {
  reason="$1"
  log "bootstrap failed: ${reason}; restoring baseline ${BASELINE}"
  git -C "$PRODUCTION_ROOT" checkout --quiet --detach "$BASELINE" || true
  michel_load_env_from_production
  michel_compose up -d --build || true
  write_state failed-rolled-back "$reason"
  fail "$reason; timer remains disabled and approval remains non-reusable"
}

# Claim removes the active one-shot authorization before the first stateful
# operation. Any failure requires a fresh exact-target approval.
cd "$TOOL_ROOT/docs/deploy"
. ./lib.sh
michel_claim_deploy_approval "$PRODUCTION_ROOT" "$TARGET" "$APPROVAL" "$CLAIMED_APPROVAL" ||
  fail "approval changed before it could be claimed"
write_state claimed "preconditions passed; timer frozen"

# Backup the healthy baseline before checkout/build/container mutation.
michel_load_env_from_production
sh ./backup.sh || { write_state failed "backup failed; no application mutation attempted"; fail "backup failed"; }

git -C "$PRODUCTION_ROOT" checkout --quiet --detach "$TARGET" || rollback_baseline "target checkout failed"
michel_load_env_from_production
export MICHEL_RELEASE_SHA="$TARGET"
michel_compose up -d --build || rollback_baseline "target build/start failed"

READY_BODY=""
i=0
while [ "$i" -lt 30 ]; do
  READY_BODY="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  READY_SHA="$(michel_readiness_release_sha "$READY_BODY" 2>/dev/null || true)"
  IMAGE_SHA="$(michel_running_image_revision 2>/dev/null || true)"
  if michel_reconcile_release "$TARGET" "$READY_SHA" "$IMAGE_SHA"; then break; fi
  i=$((i + 1)); sleep 2
done
michel_bootstrap_candidate_result "$TARGET" pass "${READY_SHA:-}" "${IMAGE_SHA:-}" || rollback_baseline "health/provenance reconciliation failed"

# Bounded post-deploy observation; every sample remains exact-candidate bound.
OBSERVATION_SECONDS="${MICHEL_BOOTSTRAP_OBSERVATION_SECONDS:-60}"
printf '%s' "$OBSERVATION_SECONDS" | grep -Eq '^[0-9]+$' || rollback_baseline "invalid observation duration"
[ "$OBSERVATION_SECONDS" -ge 30 ] || rollback_baseline "observation duration must be at least 30 seconds"
elapsed=0
while [ "$elapsed" -lt "$OBSERVATION_SECONDS" ]; do
  sleep 5
  READY_BODY="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  READY_SHA="$(michel_readiness_release_sha "$READY_BODY" 2>/dev/null || true)"
  IMAGE_SHA="$(michel_running_image_revision 2>/dev/null || true)"
  michel_reconcile_release "$TARGET" "$READY_SHA" "$IMAGE_SHA" || rollback_baseline "post-deploy observation failed"
  michel_compose exec -T db psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'select 1' | grep -qx 1 ||
    rollback_baseline "database observation failed"
  elapsed=$((elapsed + 5))
done

# Prove the checked-out target contains the permanent gate before restoring
# automation. Unit installation happens only after deployment observation.
grep -q 'michel_validate_deploy_approval' "$PRODUCTION_ROOT/docs/deploy/auto-deploy.sh" || rollback_baseline "permanent approval gate is absent"
install -m 0644 "$PRODUCTION_ROOT/docs/deploy/michel-auto-deploy.service" /etc/systemd/system/michel-auto-deploy.service ||
  rollback_baseline "service installation failed"
install -m 0644 "$PRODUCTION_ROOT/docs/deploy/michel-auto-deploy.timer" /etc/systemd/system/michel-auto-deploy.timer ||
  rollback_baseline "timer installation failed"
systemctl daemon-reload || rollback_baseline "systemd reload failed"

STAMP="$PRODUCTION_ROOT/.swarm/deployed-sha"
michel_write_deployed_stamp "$TARGET" "$READY_SHA" "$IMAGE_SHA" "$STAMP" || rollback_baseline "deployment stamp guard failed"

cd "$TOOL_ROOT/docs/deploy"
. ./lib.sh
michel_consume_deploy_approval "$TARGET" "$CLAIMED_APPROVAL" "$USED_APPROVAL" ||
  rollback_baseline "successful bootstrap approval could not be consumed"
write_state observed "exact target healthy; gate installed; approval consumed"
systemctl enable --now "$TIMER" || fail "release is healthy but timer could not be re-enabled; leave it disabled and repair manually"
write_state complete "normal exact-SHA gated timer enabled"
log "COMPLETE ${TARGET}; baseline ${BASELINE} retained for rollback"
