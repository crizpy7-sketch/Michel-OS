#!/bin/sh
set -eu

cd "$(dirname "$0")"
. ./lib.sh

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: sh restore.sh backups/michel-YYYYMMDDTHHMMSSZ.sql.gz" >&2
  exit 1
fi

michel_load_env

file="$1"
printf 'This will replace data in database %s (project %s). Type RESTORE to continue: ' \
  "$POSTGRES_DB" "$MICHEL_PROJECT"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Restore cancelled."; exit 1; }

gzip -dc "$file" | michel_compose exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Restore completed from: $file"
