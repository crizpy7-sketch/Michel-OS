# Michel OS — VPS deployment

This is the production stack accepted by `docs/decisions/ADR-001-self-hosted-stack.md`:

- `app`: Michel OS on Node 22
- `db`: PostgreSQL 16
- `web`: Caddy with automatic HTTPS

The database is not exposed to the internet. Only ports 80/443 are published.

## First deployment

Prerequisites on the VPS: Git, Docker Engine, and Docker Compose v2. Point a DNS A/AAAA record for your chosen hostname at the VPS before starting Caddy.

```sh
git clone <your Michel-OS repository URL>
cd Michel-OS/docs/deploy
cp .env.example .env
```

Edit `.env` and set:

- `CADDY_DOMAIN` — hostname only, for example `family.example.com`
- `BASE_URL` — full HTTPS URL, for example `https://family.example.com`
- `POSTGRES_PASSWORD` — use a long URL-safe random value; `openssl rand -hex 32` is suitable

Then:

```sh
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
curl -fsS "${BASE_URL:-https://your-domain.example}/api/ready"
```

The app process runs database migrations before it starts listening. If a previously applied migration was edited, boot refuses rather than guessing which schema is real.

## Updating

```sh
cd Michel-OS
git pull --ff-only
cd docs/deploy
./backup.sh
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
```

Check `/api/ready` and open the app on a phone after every production update.

## Backups

```sh
cd docs/deploy
chmod +x backup.sh restore.sh
./backup.sh
```

Backups are written to `docs/deploy/backups/` as compressed PostgreSQL dumps. The script retains 28 days by default. Copy backups off the VPS as well; a backup stored only on the same server is not disaster recovery.

A daily cron entry can call the script, for example:

```cron
15 3 * * * cd /path/to/Michel-OS/docs/deploy && ./backup.sh >> /var/log/michel-backup.log 2>&1
```

## Restore drill

Restore is intentionally interactive and requires typing `RESTORE`:

```sh
cd docs/deploy
./restore.sh backups/michel-YYYYMMDDTHHMMSSZ.sql.gz
```

Run a restore drill on a non-production copy before relying on the backup policy.

## Production verification checklist

1. `docker compose ps` shows `db`, `app`, and `web` healthy/running.
2. `https://<domain>/api/ready` returns HTTP 200.
3. Register/login works over HTTPS and the session survives a reload.
4. Create an appointment, recurring practice, reminder, shopping item, and errand; reload and confirm persistence.
5. Add a Shia Baby employee and assign a shift; confirm coverage warnings behave as expected.
6. Record a product, stock movement, sale, and expense; confirm the tax set-aside still carries its estimate disclaimer.
7. Test the home screen and mini-app navigation on phone, tablet, and desktop widths.
8. Run `./backup.sh`, restore that dump into a disposable database, and verify the household exists.

## Useful commands

```sh
# Logs
docker compose --env-file .env logs -f app

# Database status
docker compose --env-file .env exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Restart only the app
docker compose --env-file .env restart app

# Stop without deleting data
docker compose --env-file .env down
```

Do **not** use `docker compose down -v` on production unless you intend to delete the PostgreSQL and Caddy volumes.
