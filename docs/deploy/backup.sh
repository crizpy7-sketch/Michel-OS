#!/bin/sh
set -eu

cd "$(dirname "$0")"
. ./lib.sh

michel_load_env

mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="backups/michel-${stamp}.sql.gz"

michel_compose exec -T db \
  pg_dump --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip -9 > "$file"

# A dump that produced almost nothing means the database was empty or the
# wrong project was addressed. Either way the operator needs to know NOW, not
# at restore time — so fail loudly rather than leaving a useless file behind.
size="$(wc -c < "$file")"
if [ "$size" -lt 1000 ]; then
  echo "ERROR: backup is only ${size} bytes — refusing to keep it." >&2
  echo "Check that project '${MICHEL_PROJECT}' is running: michel_compose ps" >&2
  rm -f "$file"
  exit 1
fi

# Keep four weeks of daily backups by default.
find backups -type f -name 'michel-*.sql.gz' -mtime +28 -delete

echo "Backup written: $file (${size} bytes)"
