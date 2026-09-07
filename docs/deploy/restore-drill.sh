#!/bin/sh
# Prove a Michel PostgreSQL backup can be restored without touching production.
# The only database this script can address is a fresh, disposable Postgres 16
# container on a private temporary Docker network and volume.
set -eu

cd "$(dirname "$0")"
. ./lib.sh

BACKUP="${1:-}"
[ -n "$BACKUP" ] || { echo "Usage: sh restore-drill.sh backup.sql.gz" >&2; exit 2; }
case "$BACKUP" in *.sql.gz) ;; *) echo "Backup must end in .sql.gz" >&2; exit 2;; esac
[ -f "$BACKUP" ] || { echo "Backup does not exist: $BACKUP" >&2; exit 1; }

REPO_ROOT="$(cd ../.. && pwd)"
EVIDENCE="${MICHEL_RESTORE_EVIDENCE:-${REPO_ROOT}/.swarm/restore-drill.json}"
CANDIDATE="${MICHEL_CANDIDATE_SHA:-}"
if [ -n "$CANDIDATE" ]; then
  CANDIDATE="$(michel_normalize_release_sha "$CANDIDATE")" || { echo "Invalid candidate SHA" >&2; exit 1; }
fi

# Corruption is rejected before Docker is touched.
gzip -t "$BACKUP" || { echo "Backup failed gzip integrity" >&2; exit 1; }

SUFFIX="drill-$$"
NETWORK="michel-restore-${SUFFIX}"
CONTAINER="michel-restore-db-${SUFFIX}"
VOLUME="michel-restore-data-${SUFFIX}"
DB_NAME="michel_restore"
DB_USER="michel_restore"
DB_PASSWORD="$(openssl rand -hex 24)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker network create "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$CONTAINER" --network "$NETWORK" \
  --mount "type=volume,source=${VOLUME},target=/var/lib/postgresql/data" \
  -e "POSTGRES_DB=${DB_NAME}" -e "POSTGRES_USER=${DB_USER}" \
  -e "POSTGRES_PASSWORD=${DB_PASSWORD}" postgres:16-alpine >/dev/null

i=0
# pg_isready proves the server socket accepts connections, not that the named
# database has finished creation. Require a real query against the target.
until docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -At -U "$DB_USER" -d "$DB_NAME" \
  -c 'select 1' 2>/dev/null | grep -qx 1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "Disposable PostgreSQL did not become ready" >&2; exit 1; }
  sleep 1
done

gzip -dc "$BACKUP" | docker exec -i "$CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -At -U "$DB_USER" -d "$DB_NAME" \
  -c 'select 1' | grep -qx 1

MIGRATION_COUNT="$(docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -At -U "$DB_USER" -d "$DB_NAME" \
  -c "select count(*) from schema_migration")"
[ "$MIGRATION_COUNT" -gt 0 ] || { echo "Restored schema has no migration records" >&2; exit 1; }

REQUIRED_TABLES='app_user household member schedule event'
for table in $REQUIRED_TABLES; do
  present="$(docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -At -U "$DB_USER" -d "$DB_NAME" \
    -c "select to_regclass('public.${table}') is not null")"
  [ "$present" = t ] || { echo "Restored schema is missing ${table}" >&2; exit 1; }
done

mkdir -p "$(dirname "$EVIDENCE")"
BACKUP_SHA="$(sha256sum "$BACKUP" | awk '{print $1}')"
BACKUP_BYTES="$(wc -c < "$BACKUP" | tr -d ' ')"
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const fs = require("node:fs");
  const [path,candidate,name,digest,bytes,migrations,observedAt] = process.argv.slice(1);
  fs.writeFileSync(path, JSON.stringify({schemaVersion:"1.0.0",scope:"disposable-restore-drill",
    candidateSha:candidate||null,observedAt,productionDatabaseAccessed:false,postgresImage:"postgres:16-alpine",
    backup:{name,digest:`sha256:${digest}`,bytes:Number(bytes),gzipIntegrity:"pass"},
    restore:{state:"pass",queryable:true,migrationRecords:Number(migrations),
      requiredTables:["app_user","household","member","schedule","event"],cleanup:"registered"}},null,2)+"\n");
' "$EVIDENCE" "$CANDIDATE" "$(basename "$BACKUP")" "$BACKUP_SHA" "$BACKUP_BYTES" "$MIGRATION_COUNT" "$OBSERVED_AT"
sha256sum "$EVIDENCE" > "${EVIDENCE%.json}.sha256"
echo "[restore-drill] PASS evidence=$EVIDENCE"
