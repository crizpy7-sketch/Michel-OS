#!/bin/sh
# CI-only integration proof for one exact Michel OS candidate. Everything this
# script creates is disposable inside the GitHub-hosted runner. It deliberately
# knows nothing about the VPS, production credentials, domains or deployment.
set -eu

cd "$(dirname "$0")"
. ./lib.sh

CANDIDATE="${MICHEL_CANDIDATE_SHA:?MICHEL_CANDIDATE_SHA is required}"
SOURCE_REPOSITORY="${MICHEL_SOURCE_REPOSITORY:-https://github.com/crizpy7-sketch/Michel-OS}"
EXPECTED_SOURCE="https://github.com/crizpy7-sketch/Michel-OS"
REPO_ROOT="$(cd ../.. && pwd)"
IMAGE="michel-os-release-provenance:${CANDIDATE}"
SUFFIX="$(printf '%s' "$CANDIDATE" | cut -c1-12)"
NETWORK="michel-provenance-${SUFFIX}"
DB_CONTAINER="michel-provenance-db-${SUFFIX}"
APP_CONTAINER="michel-provenance-app-${SUFFIX}"
DB_NAME="michel_ci_${SUFFIX}"
DB_USER="michel_ci_${SUFFIX}"
DB_PASSWORD="$(openssl rand -hex 24)"
EVIDENCE_DIR="${REPO_ROOT}/.swarm"
EVIDENCE="${EVIDENCE_DIR}/release-provenance-ci.json"

fail() {
  echo "[release-provenance-ci] ERROR: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$APP_CONTAINER" "$DB_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

CANDIDATE="$(michel_normalize_release_sha "$CANDIDATE")" \
  || fail 'candidate is not an exact 40-character Git SHA'
[ "$SOURCE_REPOSITORY" = "$EXPECTED_SOURCE" ] \
  || fail "source repository must be ${EXPECTED_SOURCE}"

cd "$REPO_ROOT"
docker build \
  --build-arg "RELEASE_SHA=${CANDIDATE}" \
  --build-arg "SOURCE_REPOSITORY=${SOURCE_REPOSITORY}" \
  --tag "$IMAGE" \
  --file docs/deploy/Dockerfile \
  .

OCI_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE")"
OCI_SOURCE="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "$IMAGE")"
OCI_REVISION="$(michel_normalize_release_sha "$OCI_REVISION")" \
  || fail 'built image has no exact OCI revision'
[ "$OCI_REVISION" = "$CANDIDATE" ] || fail 'built image OCI revision does not match the candidate'
[ "$OCI_SOURCE" = "$EXPECTED_SOURCE" ] || fail 'built image OCI source does not match Michel OS'

docker network create "$NETWORK" >/dev/null
docker run --detach --name "$DB_CONTAINER" --network "$NETWORK" \
  --env "POSTGRES_DB=${DB_NAME}" \
  --env "POSTGRES_USER=${DB_USER}" \
  --env "POSTGRES_PASSWORD=${DB_PASSWORD}" \
  postgres:16-alpine >/dev/null

DB_READY=0
i=0
while [ "$i" -lt 30 ]; do
  if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    DB_READY=1
    break
  fi
  i=$((i + 1))
  sleep 2
done
[ "$DB_READY" -eq 1 ] || fail 'ephemeral PostgreSQL did not become ready'

docker run --detach --name "$APP_CONTAINER" --network "$NETWORK" \
  --publish 127.0.0.1::3000 \
  --env "DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@${DB_CONTAINER}:5432/${DB_NAME}" \
  --env 'BASE_URL=http://127.0.0.1' \
  --env 'ALLOW_INSECURE=true' \
  "$IMAGE" >/dev/null

HOST_PORT="$(docker port "$APP_CONTAINER" 3000/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p')"
[ -n "$HOST_PORT" ] || fail 'could not resolve the disposable app port'
READY_BODY=''
i=0
while [ "$i" -lt 45 ]; do
  if response="$(curl -fsS --max-time 3 "http://127.0.0.1:${HOST_PORT}/api/ready" 2>/dev/null)"; then
    READY_BODY="$response"
    break
  fi
  i=$((i + 1))
  sleep 2
done
[ -n "$READY_BODY" ] || fail 'ephemeral Michel OS did not become ready'

# Exact key validation proves the public readiness response contains no config,
# credentials or other accidental environment disclosure.
node -e '
  const body = JSON.parse(process.argv[1]);
  const keys = Object.keys(body).sort();
  if (body.ready !== true || keys.join(",") !== "ready,releaseSha") process.exit(1);
' "$READY_BODY" || fail 'readiness response was not the minimal provenance contract'
printf '%s' "$READY_BODY" | grep -F "$DB_PASSWORD" >/dev/null \
  && fail 'readiness response exposed the disposable database password'

READY_RELEASE_SHA="$(michel_readiness_release_sha "$READY_BODY")" \
  || fail 'readiness response has no exact release SHA'
RUNNING_OCI_REVISION="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$APP_CONTAINER")"
RUNNING_OCI_REVISION="$(michel_normalize_release_sha "$RUNNING_OCI_REVISION")" \
  || fail 'running container has no exact OCI revision'

michel_reconcile_release "$CANDIDATE" "$READY_RELEASE_SHA" "$RUNNING_OCI_REVISION" \
  || fail 'candidate, readiness and running image provenance did not reconcile'

MISMATCH='ffffffffffffffffffffffffffffffffffffffff'
[ "$MISMATCH" = "$CANDIDATE" ] && MISMATCH='0000000000000000000000000000000000000000'
if michel_reconcile_release "$CANDIDATE" "$MISMATCH" "$RUNNING_OCI_REVISION"; then
  fail 'negative reconciliation accepted an intentionally mismatched SHA'
fi

mkdir -p "$EVIDENCE_DIR"
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const fs = require("node:fs");
  const [path, candidate, source, imageRevision, readyRevision, observedAt] = process.argv.slice(1);
  fs.writeFileSync(path, `${JSON.stringify({
    schemaVersion: "1.0.0",
    evidenceScope: "ci-only",
    candidateSha: candidate,
    repository: "crizpy7-sketch/Michel-OS",
    observedAt,
    codeCiProvenance: {
      state: "pass",
      imageBuiltFromCandidate: true,
      ociRevision: imageRevision,
      ociSource: source
    },
    ephemeralRuntime: {
      state: "pass",
      postgres: "postgres:16-alpine",
      ready: true,
      releaseSha: readyRevision,
      readinessKeys: ["ready", "releaseSha"],
      secretsExposed: false,
      runningOciRevision: imageRevision
    },
    reconciliation: {
      state: "pass",
      candidateSha: candidate,
      readinessSha: readyRevision,
      imageRevision,
      negativeMismatchRejected: true
    },
    productionDeploymentObservation: {
      state: "needs-evidence",
      observed: false,
      reason: "CI is disposable and did not contact or mutate Michel OS production."
    }
  }, null, 2)}\n`);
' "$EVIDENCE" "$CANDIDATE" "$OCI_SOURCE" "$RUNNING_OCI_REVISION" "$READY_RELEASE_SHA" "$OBSERVED_AT"
sha256sum "$EVIDENCE" > "${EVIDENCE_DIR}/release-provenance-ci.sha256"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Michel OS release provenance'
    echo
    echo "- Candidate: \`${CANDIDATE}\`"
    echo "- OCI revision: \`${RUNNING_OCI_REVISION}\`"
    echo "- OCI source: \`${OCI_SOURCE}\`"
    echo "- /api/ready releaseSha: \`${READY_RELEASE_SHA}\`"
    echo '- Exact reconciliation: PASS'
    echo '- Intentional mismatch rejection: PASS'
    echo '- Evidence scope: CI image + ephemeral runtime only; no production evidence'
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "[release-provenance-ci] PASS candidate=${CANDIDATE} oci=${RUNNING_OCI_REVISION} ready=${READY_RELEASE_SHA}"
