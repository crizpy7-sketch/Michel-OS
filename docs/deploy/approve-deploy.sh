#!/bin/sh
# Create one local, exact-candidate production deployment authorization.
# This does not deploy anything; it only records Cristian's explicit decision.
set -eu

cd "$(dirname "$0")"
. ./lib.sh
TOOL_ROOT="$(cd ../.. && pwd)"
REPO_ROOT="${MICHEL_OPERATIONAL_ROOT:-$TOOL_ROOT}"

MODE="normal"
QUALITY_RECEIPT=""
RESTORE_EVIDENCE=""
if [ "${1:-}" = "--bootstrap" ]; then
  [ "$#" -eq 4 ] || {
    echo "Usage: MICHEL_OPERATIONAL_ROOT=/opt/michel-os sh approve-deploy.sh --bootstrap <exact-sha> <quality-receipt.json> <restore-evidence.json>" >&2
    exit 2
  }
  MODE="bootstrap-gated-release"
  TARGET_INPUT="$2"
  QUALITY_RECEIPT="$3"
  RESTORE_EVIDENCE="$4"
else
  [ "$#" -eq 1 ] || { echo "Usage: sh approve-deploy.sh <exact-40-char-sha>" >&2; exit 2; }
  TARGET_INPUT="$1"
fi

TARGET="$(michel_require_git_commit "$REPO_ROOT" "$TARGET_INPUT")" || {
  echo "Approval target must be an exact commit available in this repository" >&2; exit 1;
}

QUALITY_DIGEST=""
RESTORE_DIGEST=""
if [ "$MODE" = "bootstrap-gated-release" ]; then
  QUALITY_DIGEST="$(michel_file_sha256 "$QUALITY_RECEIPT")" || { echo "Quality receipt is missing" >&2; exit 1; }
  RESTORE_DIGEST="$(michel_file_sha256 "$RESTORE_EVIDENCE")" || { echo "Restore evidence is missing" >&2; exit 1; }
  michel_validate_quality_receipt "$QUALITY_RECEIPT" "$TARGET" "$QUALITY_DIGEST" \
    || { echo "Quality receipt is not a valid exact-target pre-deployment release-readiness PASS" >&2; exit 1; }
  michel_validate_real_backup_restore_evidence "$RESTORE_EVIDENCE" "$RESTORE_DIGEST" \
    || { echo "Real-production-backup restore evidence is invalid" >&2; exit 1; }
fi

EXPECTED="APPROVE DEPLOY ${TARGET}"
[ -t 0 ] || { echo "Interactive Cristian confirmation is required" >&2; exit 1; }
echo "Type exactly: ${EXPECTED}" >&2
IFS= read -r CONFIRMATION
[ "$CONFIRMATION" = "$EXPECTED" ] || { echo "Approval confirmation did not match the exact SHA" >&2; exit 1; }

RECEIPT="${REPO_ROOT}/.swarm/deploy-approval.json"
mkdir -p "$(dirname "$RECEIPT")"
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TEMPORARY="${RECEIPT}.tmp.$$"
node - "$TEMPORARY" "$TARGET" "$OBSERVED_AT" "$MODE" "$QUALITY_DIGEST" "$RESTORE_DIGEST" <<'NODE'
const fs = require('node:fs');
const [path, candidateSha, approvedAt, purpose, qualityDigest, restoreDigest] = process.argv.slice(2);
const receipt = {
  schemaVersion: '1.0.0', kind: 'deployment-approval', action: 'deploy', state: 'approved',
  candidateSha, repository: 'crizpy7-sketch/Michel-OS', approvedBy: 'Cristian', approvedAt,
  source: 'local-operator-confirmation', purpose
};
if (purpose === 'bootstrap-gated-release') {
  receipt.qualityReceiptDigest = `sha256:${qualityDigest}`;
  receipt.restoreEvidenceDigest = `sha256:${restoreDigest}`;
}
fs.writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 600 "$TEMPORARY"
mv "$TEMPORARY" "$RECEIPT"
echo "[approve-deploy] APPROVED exact candidate ${TARGET}; no deployment was performed"
