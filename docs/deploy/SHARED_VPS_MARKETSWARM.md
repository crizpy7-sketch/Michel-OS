# Michel OS on the MarketSwarm VPS

Michel OS can share the VPS that already runs MarketSwarm, but the two systems must remain operationally isolated.

## Isolation contract

Michel OS must not:

- stop, restart, replace, or reconfigure the `marketswarm` service;
- write inside `MARKETSWARM_DATA_DIR` (normally `/var/lib/marketswarm`);
- mount the MarketSwarm SQLite database or reports directory;
- expose or proxy the MarketSwarm API as part of Michel OS deployment;
- claim a host port already in use by MarketSwarm or the VPS reverse proxy;
- reuse MarketSwarm API/provider secrets.

Michel OS uses its own Docker project, PostgreSQL volume, environment file, application port, backups, and optional OpenAI key.

## Shared-VPS topology

```text
Internet
   |
existing host reverse proxy (HTTPS :443)
   |
   +--> Michel OS hostname --> 127.0.0.1:3100
   |
   +--> any existing MarketSwarm route remains unchanged

Michel OS Docker project
   app :3000  <---->  PostgreSQL :5432
     |
     + published only as 127.0.0.1:3100

MarketSwarm
   existing systemd/Docker runtime and /var/lib/marketswarm remain untouched
```

The shared compose file is `compose.shared-vps.yml`. Unlike the standalone compose file it deliberately does **not** launch Caddy and does **not** bind ports 80/443.

## Preflight on the VPS

Run these checks before starting Michel OS:

```sh
# 1. Record MarketSwarm's current state. Do not proceed if it is unhealthy.
systemctl is-active marketswarm 2>/dev/null || true
systemctl status marketswarm --no-pager 2>/dev/null || true

docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'

# 2. Confirm its persistent data exists before touching anything else.
sudo ls -ld /var/lib/marketswarm 2>/dev/null || true

# 3. See which public and candidate Michel ports are already occupied.
sudo ss -ltnp | grep -E ':(80|443|3100)\\b' || true

# 4. Capacity check.
df -h /
free -h
```

If port `3100` is already used, set a different loopback-only port in Michel OS `.env`:

```sh
MICHEL_BIND_PORT=3101
```

and make the reverse proxy point to the same port.

## Deploy Michel OS without disturbing MarketSwarm

Recommended directory layout:

```text
/opt/marketswarm/     # existing deployment, do not modify from Michel OS
/var/lib/marketswarm/ # existing MarketSwarm state
/opt/michel-os/       # Michel OS checkout
```

For Michel OS:

```sh
sudo mkdir -p /opt/michel-os
sudo chown "$USER":"$USER" /opt/michel-os
cd /opt/michel-os

git clone https://github.com/crizpy7-sketch/Michel-OS.git .
git checkout main
cd docs/deploy
cp .env.example .env
```

Edit `.env` with a Michel-specific database password and hostname. Do not copy MarketSwarm secrets into it.

Then start only the Michel services:

```sh
docker compose --project-name michel-os \
  --env-file .env \
  -f compose.shared-vps.yml \
  up -d --build
```

Verify the private loopback service before exposing it through the reverse proxy:

```sh
curl -fsS http://127.0.0.1:${MICHEL_BIND_PORT:-3100}/api/ready

docker compose --project-name michel-os \
  --env-file .env \
  -f compose.shared-vps.yml ps
```

Only after that succeeds should the Michel OS hostname be added to the existing reverse proxy. `Caddyfile.shared-vps.example` shows the Caddy form. If the VPS uses another reverse proxy, preserve its current configuration and add only an equivalent Michel OS virtual host.

## Post-deploy MarketSwarm non-regression check

Immediately after Michel OS comes up:

```sh
systemctl is-active marketswarm 2>/dev/null || true
marketswarm status 2>/dev/null || true

# If MarketSwarm itself runs through Docker, inspect its existing project too.
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

The Michel deployment is not accepted if MarketSwarm changed state, lost its data mount, lost a port, or stopped producing its normal status/logs.

## Backups

Michel OS backups remain under `docs/deploy/backups/` and cover Michel PostgreSQL only. MarketSwarm's SQLite database and reports stay under its own data directory and keep their existing backup policy. Never merge the two backup trees.

## Production acceptance

A shared-VPS release is verified only after all of the following are observed on the real server:

1. MarketSwarm is healthy before deployment.
2. Port selected for Michel OS is free and loopback-only.
3. Michel PostgreSQL is healthy in its own Docker volume.
4. `http://127.0.0.1:<MICHEL_BIND_PORT>/api/ready` returns 200.
5. The public Michel hostname works over HTTPS through the existing reverse proxy.
6. Michel registration/login and persistence work after a container restart.
7. MarketSwarm remains healthy and its existing data directory is unchanged.
8. Michel backup and disposable restore drill succeed.
9. Real PostgreSQL concurrency checks from the main deployment runbook pass.

Do not label the shared-VPS deployment verified until those observations have been made on the live host.
