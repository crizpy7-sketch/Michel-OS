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
