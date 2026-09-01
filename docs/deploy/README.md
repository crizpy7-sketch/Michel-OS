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

MICHEL_RELEASE_SHA="$(git -C ../.. rev-parse HEAD)" \
docker compose --project-name michel-os \
  --env-file .env \
  -f compose.shared-vps.yml \
  up -d --build

curl -fsS http://127.0.0.1:${MICHEL_BIND_PORT:-3100}/api/ready
```

Then add only the Michel hostname to the VPS's existing HTTPS reverse proxy. See `Caddyfile.shared-vps.example` for Caddy syntax and `SHARED_VPS_MARKETSWARM.md` for the required MarketSwarm preflight and non-regression checks.

## Automatic deployment

Once installed, anything pushed to `main` that passes CI goes live within a few
minutes. No manual step, and no credentials leave the VPS.

```sh
sudo sh /opt/michel-os/docs/deploy/install-auto-deploy.sh
```

That installs a systemd timer which every 3 minutes:

1. checks `origin/main` for a new commit — exits silently when there is none;
2. **refuses to deploy unless that commit's `gauntlet` workflow passed**;
3. backs up the database, and aborts if the backup is not a real dump;
4. checks out the exact target commit and supplies that 40-character SHA as the
   Docker build and runtime release identity;
5. rebuilds, restarts, and polls `/api/ready` for 60 seconds;
6. reconciles the target Git SHA, `/api/ready` release SHA, and running image's
   OCI revision label, and **rolls back to the previous commit** if health or
   provenance does not match;
7. writes `.swarm/deployed-sha` only after all three identities agree.

```sh
journalctl -u michel-auto-deploy -f                    # watch it work
sh /opt/michel-os/docs/deploy/auto-deploy.sh --force   # deploy right now
systemctl disable --now michel-auto-deploy.timer       # stop auto-deploying
```

### Why pull-based rather than a GitHub Action that SSHes in

A push-based deploy needs an SSH private key in GitHub secrets and an inbound
path from GitHub's runners to this host. On a VPS that also runs somebody else's
production service, that is a lot of new attack surface bought for a few seconds
of latency. Here nothing leaves the VPS and nothing needs to reach it, so a
leaked repository secret cannot touch the host.

### The CI gate is the point

`MICHEL_REQUIRE_CI=true` is the default and should stay that way. Without it,
"push to main" also means "any broken commit takes the family calendar down,
automatically, at 3am". For a private repository set `GITHUB_TOKEN` in `.env` so
the deploy can read commit status; without one it skips rather than guesses.

### Safety properties

- **Refuses to run on a dirty working tree** — local edits on the box are never
  silently destroyed by a checkout.
- **Backs up before every deploy**, and treats a suspiciously small dump as a
  failure rather than keeping a useless file.
- **Rolls back automatically** on a failed build or a failed health check.
- **Fails closed on release-provenance mismatch** and leaves the previous
  successful deployment stamp intact.
- **Never touches anything outside its own compose project.**

## Exact release provenance

The deployment identity has one source: the exact Git candidate selected by the
deployment controller. The controller supplies it as `MICHEL_RELEASE_SHA` to the
Docker build; it is not discovered from Git inside the container. The build
validates the value as exactly 40 hexadecimal characters, records it as the
`org.opencontainers.image.revision` OCI label, and embeds the same non-secret
value for the application runtime. A database-ready app then reports:

```json
{"ready":true,"releaseSha":"<exact-40-character-git-sha>"}
```

The automatic deployer compares that response and the running image label to
the target before updating `.swarm/deployed-sha`. Missing, malformed, stale, or
conflicting provenance fails the deployment. The source label is the stable
repository identifier `https://github.com/crizpy7-sketch/Michel-OS`.

This reconciliation proves release identity; it does not prove that a database
backup can be restored. Recovery still requires a separately observed restore
drill and the production acceptance checks below.

The existing GitHub Actions gauntlet also builds the real image for the exact
candidate and starts disposable PostgreSQL and Michel OS containers inside the
runner. It verifies the OCI labels, minimal readiness response, positive
reconciliation, and an intentional mismatch rejection. It then creates a real
logical backup, restores that backup into a second isolated PostgreSQL 16
instance, rejects a corrupt backup, simulates the guarded rollback stamp, and
compares the affected readiness path with the exact pre-change baseline on the
same runner. Candidate-bound JSON receipts and SHA-256 digests are retained.
These are code/CI, ephemeral-runtime, restore-drill, rollback-simulation and
performance-smoke evidence only; none is production restore or deployment
evidence.

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
MICHEL_RELEASE_SHA="$(git -C ../.. rev-parse HEAD)" \
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
MICHEL_RELEASE_SHA="$(git -C ../.. rev-parse HEAD)" \
  docker compose --env-file .env up -d --build
docker compose --env-file .env ps
```

Shared MarketSwarm VPS:

```sh
cd /opt/michel-os
git pull --ff-only
cd docs/deploy
./backup.sh
MICHEL_RELEASE_SHA="$(git -C ../.. rev-parse HEAD)" \
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

For the bounded disposable drill, which cannot address the Compose database:

```sh
./restore-drill.sh backups/michel-YYYYMMDDTHHMMSSZ.sql.gz
```

It verifies gzip integrity, restores into a newly created private Docker
network/container/volume using `postgres:16-alpine`, checks queryability,
migration records and core Michel tables, writes a secret-free machine receipt,
then removes every temporary Docker resource. A passing drill proves that copy
was restorable in that environment; it is not production recovery proof.

## Manual rollback

A future approved operator rollback requires an exact commit that exists in the
local repository and an explicit matching confirmation:

```sh
MICHEL_ROLLBACK_CONFIRM=<40-char-sha> \
  ./manual-rollback.sh --rollback-to <40-char-sha>
```

The script backs up before checkout, injects that SHA into build/runtime, waits
for database-backed readiness, reconciles `/api/ready.releaseSha` with the
running OCI revision, and changes `.swarm/deployed-sha` only after all checks
pass. Failure rebuilds the previous checkout without stamping success. It must
still be run only with the required production approval and observed rollback/
backup preconditions; the CI simulation does not authorize or prove a live
rollback.

## Production verification checklist

1. The selected Michel compose project shows its services healthy/running.
2. `/api/ready` returns HTTP 200 from the intended private/public path and its
   `releaseSha` matches both the selected Git candidate and the running image's
   `org.opencontainers.image.revision` label.
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
