#!/bin/sh
# Shared helpers for the deploy scripts.
#
# Every script here has to address the SAME docker compose project. Before this
# existed each one called `docker compose` bare, which resolves to the
# standalone compose.yml and a project named after the directory — so on a
# shared VPS the backup and restore scripts silently targeted a project that
# does not exist. A backup that reports success while dumping nothing is worse
# than no backup at all.
#
# Source this from any deploy script:
#   . "$(dirname "$0")/lib.sh"
#
# Both values can be overridden in .env, which is what a standalone
# (Caddy-owning) deployment does:
#   MICHEL_COMPOSE_FILE=compose.yml

michel_load_env() {
  if [ ! -f .env ]; then
    echo "docs/deploy/.env is missing. Copy .env.example first." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a

  MICHEL_PROJECT="${MICHEL_PROJECT:-michel-os}"
  MICHEL_COMPOSE_FILE="${MICHEL_COMPOSE_FILE:-compose.shared-vps.yml}"

  if [ ! -f "$MICHEL_COMPOSE_FILE" ]; then
    echo "Compose file not found: $MICHEL_COMPOSE_FILE" >&2
    exit 1
  fi
}

# The one correct way to talk to this deployment.
michel_compose() {
  docker compose \
    --project-name "$MICHEL_PROJECT" \
    -f "$MICHEL_COMPOSE_FILE" \
    --env-file .env \
    "$@"
}

# True when the named host port is published by OUR OWN compose project.
# This is what tells "somebody else took my port" apart from "I am already
# running here", which are opposite situations with opposite correct actions.
michel_owns_port() {
  port="$1"
  docker ps \
    --filter "label=com.docker.compose.project=${MICHEL_PROJECT}" \
    --format '{{.Ports}}' 2>/dev/null \
    | grep -q ":${port}->"
}

# Print a canonical lowercase exact Git SHA, or fail without output. Branches,
# tags, prefixes and descriptive strings are not release provenance.
michel_normalize_release_sha() {
  value="$1"
  printf '%s' "$value" | grep -Eq '^[0-9a-fA-F]{40}$' || return 1
  printf '%s' "$value" | tr 'A-F' 'a-f'
}

# Require an exact commit that is actually present in the selected repository.
# This rejects abbreviated SHAs, refs and exact-looking objects that are not
# commits. It is shared by manual rollback and its CI simulation.
michel_require_git_commit() {
  repository="$1"
  requested="$(michel_normalize_release_sha "$2")" || return 1
  resolved="$(git -C "$repository" rev-parse --verify "${requested}^{commit}" 2>/dev/null)" || return 1
  resolved="$(michel_normalize_release_sha "$resolved")" || return 1
  [ "$requested" = "$resolved" ] || return 1
  printf '%s' "$resolved"
}

# Query GitHub for a completed successful gauntlet bound to one exact commit.
# The caller supplies a local repository only to resolve its canonical remote;
# CI status is fetched from GitHub and cannot be replaced by a local string.
michel_check_ci() {
  repository="$1"
  sha="$(michel_require_git_commit "$repository" "$2")" || return 2
  remote="$(git -C "$repository" remote get-url origin 2>/dev/null)" || return 2
  slug="$(printf '%s' "$remote" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  [ -n "$slug" ] || return 2
  workflow="${MICHEL_CI_WORKFLOW:-gauntlet.yml}"
  api="https://api.github.com/repos/${slug}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=10"

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    body="$(curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null || true)"
  else
    body="$(curl -fsS -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null || true)"
  fi

  [ -n "$body" ] || return 2
  printf '%s' "$body" | grep -q '"total_count": *0' && return 2
  conclusions="$(printf '%s' "$body" | tr '{},' '\n' \
    | grep -o '"conclusion": *"[^"]*"' | sed 's/.*: *"//; s/"//')"
  [ -n "$conclusions" ] || return 2
  if printf '%s\n' "$conclusions" | grep -qE '^(failure|cancelled|timed_out|action_required)$'; then
    return 1
  fi
  printf '%s\n' "$conclusions" | grep -q '^success$'
}

michel_file_sha256() {
  [ -f "$1" ] || return 1
  sha256sum "$1" | awk '{print $1}'
}

# A production bootstrap consumes only the permanent Quality Gate's scoped,
# integrity-checked pre-deployment readiness receipt. Full-lifecycle receipts
# remain separate and cannot be used to break their own observation gate.
michel_validate_quality_receipt() {
  receipt="$1"
  target="$(michel_normalize_release_sha "$2")" || return 1
  expected_digest="$(michel_normalize_digest "$3")" || return 1
  actual_digest="$(michel_file_sha256 "$receipt")" || return 1
  [ "$actual_digest" = "$expected_digest" ] || return 1
  node - "$receipt" "$target" <<'NODE'
const fs = require('node:fs');
const [path, target] = process.argv.slice(2);
let value;
try { value = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(1); }
const crypto = require('node:crypto');
const expectedScopeBinding = typeof value?.receiptId === 'string'
  ? crypto.createHash('sha256').update(`${value.receiptId}:pre-deployment-release-readiness:${target}`).digest('hex')
  : '';
if (value?.schemaVersion !== '1.1.0' ||
    value?.evaluationScope !== 'pre-deployment-release-readiness' ||
    value?.receiptStatus !== 'current' ||
    value?.repository !== 'crizpy7-sketch/Michel-OS' ||
    value?.candidateSha?.toLowerCase() !== target || value?.finalState !== 'pass' ||
    typeof value?.receiptId !== 'string' || !/^[0-9a-f]{64}$/i.test(value.receiptId) ||
    value?.scopeBindingId !== expectedScopeBinding ||
    typeof value?.evaluatedAt !== 'string' || Number.isNaN(Date.parse(value.evaluatedAt)) ||
    value?.scopeStatus?.productionDeploymentObservation !== 'not-evaluated-pre-deployment' ||
    value?.scopeStatus?.fullLifecycleEvaluation !== 'required-after-production-observation' ||
    value?.scopeStatus?.cristianApproval !== 'required-separately' ||
    value?.scopeStatus?.deploymentAuthority !== 'not-granted' ||
    value?.controlPlane?.authority !== 'shia-core' ||
    value?.controlPlane?.qualityGateMayAcceptTask !== false ||
    value?.controlPlane?.gstackMayAcceptTask !== false ||
    value?.controlPlane?.qualityEvidenceGrantsActionAuthority !== false) process.exit(1);
NODE
}

michel_normalize_digest() {
  printf '%s' "$1" | sed 's/^sha256://' | grep -Eq '^[0-9a-fA-F]{64}$' || return 1
  printf '%s' "$1" | sed 's/^sha256://' | tr 'A-F' 'a-f'
}

# This is an operator-retained attestation for a copied real production backup,
# not a claim that production itself was modified or restored.
michel_validate_real_backup_restore_evidence() {
  evidence="$1"
  expected_digest="$(michel_normalize_digest "$2")" || return 1
  actual_digest="$(michel_file_sha256 "$evidence")" || return 1
  [ "$actual_digest" = "$expected_digest" ] || return 1
  node - "$evidence" <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch { process.exit(1); }
if (value?.scope !== 'real-production-backup-isolated-restore' ||
    value?.productionDatabaseAccessed !== false || value?.postgresImage !== 'postgres:16-alpine' ||
    value?.backup?.gzipIntegrity !== 'pass' || value?.restore?.state !== 'pass' ||
    value?.restore?.queryable !== true || !(value?.restore?.migrationRecords > 0) ||
    value?.restore?.cleanup !== 'complete') process.exit(1);
const required = ['app_user', 'household', 'member', 'schedule', 'event'];
if (!required.every((table) => value.restore.requiredTables?.includes(table))) process.exit(1);
NODE
}

# Pure policy core used by the real bootstrap and deterministic simulations.
# Runtime adapters must turn observations into these exact values; absence is
# never converted into success.
michel_bootstrap_preflight() {
  baseline="$(michel_normalize_release_sha "$1")" || return 1
  target="$(michel_normalize_release_sha "$2")" || return 1
  main_sha="$(michel_normalize_release_sha "$3")" || return 1
  live_git="$(michel_normalize_release_sha "$4")" || return 1
  deployed="$(michel_normalize_release_sha "$5")" || return 1
  timer_active="$6"; timer_enabled="$7"; service_active="$8"
  approval_sha="$(michel_normalize_release_sha "$9")" || return 1
  shift 9
  ci_state="$1"; quality_state="$2"; restore_state="$3"
  [ "$timer_active" = false ] && [ "$timer_enabled" = false ] && [ "$service_active" = false ] || return 1
  [ "$live_git" = "$baseline" ] && [ "$deployed" = "$baseline" ] || return 1
  [ "$target" = "$main_sha" ] && [ "$approval_sha" = "$target" ] || return 1
  [ "$ci_state" = pass ] && [ "$quality_state" = pass ] && [ "$restore_state" = pass ]
}

michel_bootstrap_candidate_result() {
  target="$1"; backup_state="$2"; ready_sha="$3"; image_sha="$4"
  [ "$backup_state" = pass ] || return 1
  michel_reconcile_release "$target" "$ready_sha" "$image_sha"
}

# Read a strict local operator approval receipt. The VPS filesystem account is
# the trust boundary: arbitrary caller strings and CI status are not receipts.
michel_read_deploy_approval_sha() {
  receipt="$1"
  expected_state="${2:-approved}"
  [ -f "$receipt" ] || return 1
  node - "$receipt" "$expected_state" <<'NODE'
const fs = require('node:fs');
const [path, expectedState] = process.argv.slice(2);
let value;
try { value = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(1); }
if (value?.schemaVersion !== '1.0.0' || value?.kind !== 'deployment-approval' ||
    value?.action !== 'deploy' || value?.state !== expectedState ||
    value?.approvedBy !== 'Cristian' || value?.repository !== 'crizpy7-sketch/Michel-OS' ||
    value?.source !== 'local-operator-confirmation' ||
    typeof value?.approvedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.approvedAt) ||
    typeof value?.candidateSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.candidateSha)) process.exit(1);
process.stdout.write(value.candidateSha.toLowerCase());
NODE
}

michel_validate_deploy_approval() {
  repository="$1"
  target="$(michel_require_git_commit "$repository" "$2")" || return 1
  approved="$(michel_read_deploy_approval_sha "$3" approved)" || return 1
  [ "$approved" = "$target" ]
}

michel_validate_bootstrap_approval() {
  repository="$1"; target="$2"; receipt="$3"; quality_digest="$4"; restore_digest="$5"
  michel_validate_deploy_approval "$repository" "$target" "$receipt" || return 1
  quality_digest="$(michel_normalize_digest "$quality_digest")" || return 1
  restore_digest="$(michel_normalize_digest "$restore_digest")" || return 1
  node - "$receipt" "$quality_digest" "$restore_digest" <<'NODE'
const fs = require('node:fs');
const [path, qualityDigest, restoreDigest] = process.argv.slice(2);
let value;
try { value = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(1); }
if (value?.purpose !== 'bootstrap-gated-release' ||
    value?.qualityReceiptDigest !== `sha256:${qualityDigest}` ||
    value?.restoreEvidenceDigest !== `sha256:${restoreDigest}`) process.exit(1);
NODE
}

# Claim before the first production mutation. The atomic rename removes the
# active authorization even if a later command or the host fails unexpectedly.
michel_claim_deploy_approval() {
  repository="$1"; target="$2"; active="$3"; claimed="$4"
  michel_validate_deploy_approval "$repository" "$target" "$active" || return 1
  mkdir -p "$(dirname "$claimed")"
  mv "$active" "$claimed" || return 1
  node - "$claimed" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
value.state = 'claimed';
value.claimedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const temporary = `${path}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, path);
NODE
}

michel_consume_deploy_approval() {
  target="$(michel_normalize_release_sha "$1")" || return 1
  claimed="$2"; used="$3"
  approved="$(michel_read_deploy_approval_sha "$claimed" claimed)" || return 1
  [ "$approved" = "$target" ] || return 1
  node - "$claimed" "$used" <<'NODE'
const fs = require('node:fs');
const [claimed, used] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(claimed, 'utf8'));
value.state = 'consumed';
value.consumedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const temporary = `${used}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, used);
fs.unlinkSync(claimed);
NODE
}

# Extract only the small machine field owned by Michel OS. A healthy HTTP
# response without this exact field remains useful for uptime checks, but is
# insufficient for release verification.
michel_readiness_release_sha() {
  printf '%s' "$1" | tr -d '\r\n' \
    | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' || return 1
  value="$(printf '%s' "$1" | tr -d '\r\n' \
    | sed -n 's/.*"releaseSha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{40\}\)".*/\1/p')"
  [ -n "$value" ] || return 1
  michel_normalize_release_sha "$value"
}

# Resolve the revision label from the image backing the running Compose app.
michel_running_image_revision() {
  container="$(michel_compose ps -q app 2>/dev/null)"
  [ -n "$container" ] || return 1
  value="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container" 2>/dev/null)"
  michel_normalize_release_sha "$value"
}

# Production may be stamped only when the target, readiness response and
# running image independently name the same exact commit.
michel_reconcile_release() {
  target="$(michel_normalize_release_sha "$1")" || return 1
  ready="$(michel_normalize_release_sha "$2")" || return 1
  image="$(michel_normalize_release_sha "$3")" || return 1
  [ "$target" = "$ready" ] && [ "$target" = "$image" ]
}

# Guard the only successful deployed-sha write. On mismatch the pre-existing
# stamp is preserved, so a failed candidate cannot claim deployment success.
michel_write_deployed_stamp() {
  target="$1"
  ready="$2"
  image="$3"
  stamp="$4"
  michel_reconcile_release "$target" "$ready" "$image" || return 1
  mkdir -p "$(dirname "$stamp")"
  temporary="${stamp}.tmp.$$"
  printf '%s\n' "$(michel_normalize_release_sha "$target")" > "$temporary"
  mv "$temporary" "$stamp"
}
