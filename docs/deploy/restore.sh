#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "docs/deploy/.env is missing. Copy .env.example first." >&2
  exit 1
fi

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: ./restore.sh backups/michel-YYYYMMDDTHHMMSSZ.sql.gz" >&2
  exit 1
fi

set -a
. ./.env
set +a

file="$1"
printf 'This will replace data in database %s. Type RESTORE to continue: ' "$POSTGRES_DB"
read answer
[ "$answer" = "RESTORE" ] || { echo "Restore cancelled."; exit 1; }

gzip -dc "$file" | docker compose --env-file .env exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Restore completed from: $file"
