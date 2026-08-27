#!/bin/sh
# Pull-based continuous deployment.
#
# Watches origin/main. When it moves, this backs up the database, rebuilds,
# health-checks, and rolls back if the new build does not come up healthy.
#
# WHY PULL AND NOT A GITHUB ACTION THAT SSHes IN:
#
# A push-based deploy needs an SSH private key stored as a GitHub secret and an
# inbound path from GitHub's runners to this box. On a VPS that also hosts
# somebody else's production service, that is a large amount of new attack
# surface bought for a few seconds of latency. Nothing here leaves the VPS and
# nothing needs to reach it, so a leaked repo secret cannot touch the host.
#
# THE GATE THAT MATTERS:
#
# It refuses to deploy a commit whose `gauntlet` workflow did not pass. Without
# that, "push to main" means "any broken commit takes the family calendar down
# automatically", which is worse than deploying by hand. Set GITHUB_TOKEN in
# .env for private repos; without a token the public API is used and the deploy
# is skipped when the status cannot be established.
#
# Install:  sh docs/deploy/install-auto-deploy.sh
# Logs:     journalctl -u michel-auto-deploy -f
# Manual:   sh docs/deploy/auto-deploy.sh --force
set -eu

cd "$(dirname "$0")"
. ./lib.sh

REPO_ROOT="$(cd ../.. && pwd)"
BRANCH="${MICHEL_DEPLOY_BRANCH:-main}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { echo "[auto-deploy] $*"; }
fail() { echo "[auto-deploy] ERROR: $*" >&2; exit 1; }

michel_load_env

HEALTH_URL="http://127.0.0.1:${MICHEL_BIND_PORT:-3100}/api/ready"

cd "$REPO_ROOT"

# Never deploy on top of local edits to TRACKED files: the checkout below would
# silently destroy them, and their presence means somebody is working on this
# box by hand.
#
# Untracked files are deliberately not a blocker. `git checkout` does not touch
# them, so they were never at risk — and treating them as one deadlocked this
# script against its own output: backup.sh creates docs/deploy/backups/, which
# made the next run refuse to start. A guard that a script trips on its own
# side effects is worse than no guard.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail "tracked files have local modifications; refusing to deploy over them.
$(git status --short --untracked-files=no)"
fi

git fetch --quiet origin "$BRANCH" || fail "git fetch failed"

CURRENT="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "origin/${BRANCH}")"

if [ "$CURRENT" = "$TARGET" ] && [ "$FORCE" -eq 0 ]; then
  exit 0   # nothing to do; stay quiet so the timer does not spam the journal
fi

log "current  ${CURRENT}"
log "target   ${TARGET}"

# ----------------------------------------------------------- CI gate ---

check_ci() {
  sha="$1"
  remote="$(git remote get-url origin)"
  slug="$(printf '%s' "$remote" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  api="https://api.github.com/repos/${slug}/commits/${sha}/check-runs"

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    body="$(curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null || true)"
  else
    body="$(curl -fsS -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null || true)"
  fi

  [ -n "$body" ] || return 2   # could not establish status

  # Any gauntlet run that is not "success" blocks the deploy. Grepping the
  # JSON is crude but keeps this dependency-free; jq is not guaranteed present.
  printf '%s' "$body" | grep -q '"name": *"[^"]*[Gg]auntlet' || return 2
  printf '%s' "$body" \
    | tr '}' '\n' \
    | grep -i 'gauntlet' \
    | grep -q '"conclusion": *"success"'
}

if [ "${MICHEL_REQUIRE_CI:-true}" = "true" ]; then
  if check_ci "$TARGET"; then
    log "gauntlet passed for ${TARGET}"
  else
    status=$?
    if [ "$status" -eq 2 ]; then
      log "SKIP: could not establish gauntlet status for ${TARGET}. Not deploying."
      log "      Set GITHUB_TOKEN in .env for a private repo, or MICHEL_REQUIRE_CI=false to disable this gate."
    else
      log "SKIP: gauntlet did not pass for ${TARGET}. Not deploying."
    fi
    exit 0
  fi
fi

# ---------------------------------------------- backup, then deploy ---

cd "$REPO_ROOT/docs/deploy"

log "backing up the database first"
sh ./backup.sh || fail "backup failed; refusing to deploy without one"

cd "$REPO_ROOT"
log "checking out ${TARGET}"
git checkout --quiet --detach "$TARGET" || fail "checkout failed"

cd "$REPO_ROOT/docs/deploy"
log "building and starting"
if ! michel_compose up -d --build; then
  log "build/start FAILED — rolling back to ${CURRENT}"
  cd "$REPO_ROOT" && git checkout --quiet --detach "$CURRENT"
  cd "$REPO_ROOT/docs/deploy" && michel_compose up -d --build || true
  fail "deploy failed and was rolled back to ${CURRENT}"
fi

# ------------------------------------------------------ health check ---

log "waiting for health"
healthy=0
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  i=$((i + 1))
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  log "health check FAILED after 60s — rolling back to ${CURRENT}"
  michel_compose logs app --tail 40 || true
  cd "$REPO_ROOT" && git checkout --quiet --detach "$CURRENT"
  cd "$REPO_ROOT/docs/deploy" && michel_compose up -d --build || true
  fail "new build was unhealthy; rolled back to ${CURRENT}"
fi

log "DEPLOYED ${TARGET} — healthy at ${HEALTH_URL}"
