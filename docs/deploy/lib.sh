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
