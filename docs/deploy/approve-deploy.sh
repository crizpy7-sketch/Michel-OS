#!/bin/sh
# Create one local, exact-candidate production deployment authorization.
# This does not deploy anything; it only records Cristian's explicit decision.
set -eu

cd "$(dirname "$0")"
. ./lib.sh
REPO_ROOT="$(cd ../.. && pwd)"

[ "$#" -eq 1 ] || { echo "Usage: sh approve-deploy.sh <exact-40-char-sha>" >&2; exit 2; }
TARGET="$(michel_require_git_commit "$REPO_ROOT" "$1")" || {
  echo "Approval target must be an exact commit available in this repository" >&2; exit 1;
}

EXPECTED="APPROVE DEPLOY ${TARGET}"
[ -t 0 ] || { echo "Interactive Cristian confirmation is required" >&2; exit 1; }
echo "Type exactly: ${EXPECTED}" >&2
IFS= read -r CONFIRMATION
[ "$CONFIRMATION" = "$EXPECTED" ] || { echo "Approval confirmation did not match the exact SHA" >&2; exit 1; }

RECEIPT="${REPO_ROOT}/.swarm/deploy-approval.json"
mkdir -p "$(dirname "$RECEIPT")"
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TEMPORARY="${RECEIPT}.tmp.$$"
node - "$TEMPORARY" "$TARGET" "$OBSERVED_AT" <<'NODE'
const fs = require('node:fs');
const [path, candidateSha, approvedAt] = process.argv.slice(2);
fs.writeFileSync(path, `${JSON.stringify({
  schemaVersion: '1.0.0', kind: 'deployment-approval', action: 'deploy', state: 'approved',
  candidateSha, repository: 'crizpy7-sketch/Michel-OS', approvedBy: 'Cristian', approvedAt,
  source: 'local-operator-confirmation'
}, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 600 "$TEMPORARY"
mv "$TEMPORARY" "$RECEIPT"
echo "[approve-deploy] APPROVED exact candidate ${TARGET}; no deployment was performed"
