#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "docs/deploy/.env is missing. Copy .env.example first." >&2
  exit 1
fi

set -a
. ./.env
set +a

mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="backups/michel-${stamp}.sql.gz"

docker compose --env-file .env exec -T db \
  pg_dump --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip -9 > "$file"

# Keep four weeks of daily backups by default.
find backups -type f -name 'michel-*.sql.gz' -mtime +28 -delete

echo "Backup written: $file"
