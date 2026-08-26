# Michel OS — VPS deployment

Michel OS supports two production topologies:

1. **Standalone VPS** — Michel OS owns ports 80/443 and launches its own Caddy container.
2. **Shared MarketSwarm VPS** — Michel OS runs behind the VPS's existing reverse proxy, binds only to loopback, and leaves MarketSwarm untouched. Use `compose.shared-vps.yml` and read `SHARED_VPS_MARKETSWARM.md` first.

The standalone stack accepted by `docs/decisions/ADR-001-self-hosted-stack.md` is:

- `app`: Michel OS on Node 22
- `db`: PostgreSQL 16
- `web`: Caddy with automatic HTTPS

The database is never exposed to the internet.

## Shared MarketSwarm VPS

Do **not** use the standalone `compose.yml` blindly on the VPS that already runs MarketSwarm because it publishes host ports 80/443. The shared mode deliberately omits Caddy and publishes the Michel application only on `127.0.0.1:${MICHEL_BIND_PORT:-3100}`.

Start with:

```sh
cd docs/deploy
cp .env.example .env
# edit Michel-specific settings and secrets

docker compose --project-name michel-os \
  --env-file .env \
  -f compose.shared-vps.yml \
  up -d --build

curl -fsS http://127.0.0.1:${MICHEL_BIND_PORT:-3100}/api/ready
```

Then add only the Michel hostname to the VPS's existing HTTPS reverse proxy. See `Caddyfile.shared-vps.example` for Caddy syntax and `SHARED_VPS_MARKETSWARM.md` for the required MarketSwarm preflight and non-regression checks.

## Standalone first deployment

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
- `OPENAI_API_KEY` — optional; enables the OpenAI natural-language proposal provider
- `OPENAI_MODEL` — optional; defaults to `gpt-5.4-mini`
- `MICHEL_BIND_PORT` — shared-VPS mode only; defaults to `3100`

If `OPENAI_API_KEY` is blank, Michel OS stays fully usable and the Assistant falls back to the deterministic local parser. The key is server-side only and is never sent to the browser. Even with OpenAI enabled, the model only proposes a structured action; Michel OS re-validates tenant scope, permissions and domain rules before execution.

Then:

```sh
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
curl -fsS "${BASE_URL:-https://your-domain.example}/api/ready"
```

The app process runs database migrations before it starts listening. If a previously applied migration was edited, boot refuses rather than guessing which schema is real.

## Updating

Standalone:

```sh
cd Michel-OS
git pull --ff-only
cd docs/deploy
./backup.sh
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
```

Shared MarketSwarm VPS:

```sh
cd /opt/michel-os
git pull --ff-only
cd docs/deploy
./backup.sh
docker compose --project-name michel-os --env-file .env -f compose.shared-vps.yml up -d --build
docker compose --project-name michel-os --env-file .env -f compose.shared-vps.yml ps
```

Check `/api/ready` and open the app on a phone after every production update. On the shared VPS, also verify MarketSwarm remains healthy after every Michel update.

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

1. The selected Michel compose project shows its services healthy/running.
2. `/api/ready` returns HTTP 200 from the intended private/public path.
3. Register/login works over HTTPS and the session survives a reload.
4. Create an appointment, recurring practice, reminder, shopping item, and errand; reload and confirm persistence.
5. In Assistant, ask to add a shopping item; confirm a low-confidence proposal once, then verify a second execution attempt is rejected rather than duplicated.
6. If `OPENAI_API_KEY` is configured, ask the Assistant for a dated event and confirm the UI identifies OpenAI as the proposal provider while the action still passes Michel OS validation.
7. Add a Shia Baby employee and assign a shift; confirm coverage warnings behave as expected.
8. Record a product, stock movement, sale, and expense; confirm the tax set-aside still carries its estimate disclaimer.
9. Test the home screen and mini-app navigation on phone, tablet, and desktop widths.
10. Run `./backup.sh`, restore that dump into a disposable database, and verify the household exists.
11. On a shared VPS, verify MarketSwarm's service/data/ports are unchanged after Michel OS starts.

## Useful commands

```sh
# Standalone logs
docker compose --env-file .env logs -f app

# Shared-VPS logs
docker compose --project-name michel-os --env-file .env -f compose.shared-vps.yml logs -f app

# Database status
docker compose --env-file .env exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Stop standalone without deleting data
docker compose --env-file .env down

# Stop shared Michel services without touching MarketSwarm
docker compose --project-name michel-os --env-file .env -f compose.shared-vps.yml down
```

Do **not** use `docker compose down -v` on production unless you intend to delete Michel OS's persistent PostgreSQL volume. Never run Michel OS deployment commands from the MarketSwarm project directory.
