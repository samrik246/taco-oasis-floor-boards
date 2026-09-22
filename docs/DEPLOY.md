# Deploy / go-live — Taco Oasis Floor Boards

This app is a **Next.js + Prisma/SQLite** floor board meant for **LAN tablets** against a **home-base** host (MicroTouch / office PC). See the project go-live checklist: tablets open `http://HOME_BASE_IP:3000` in Chrome.

There is **no** in-repo `vercel.json`, `fly.toml`, or `Dockerfile`. CI therefore:

1. Always runs quality gates (`pnpm test`, `pnpm build`, Playwright e2e).
2. On `main` (and `workflow_dispatch`), uploads a production artifact.
3. Deploys only from a manually dispatched workflow with an explicit go-live confirmation.
4. Can use **SSH/rsync** when `DEPLOY_*` secrets are set; Vercel remains unsuitable for SQLite floor state.

Workflow file: [`.github/workflows/ci-deploy.yml`](../.github/workflows/ci-deploy.yml)

## Quality gates (every PR + push to `main`)

| Step | Command / action |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` (pnpm **10.33.3**, Node **22**) |
| Prisma | `pnpm exec prisma generate` |
| Test DB | `DEMO_MANAGER_CODES=1 DATABASE_URL=file:./dev.db pnpm db:setup` |
| Unit tests | `pnpm test` |
| Build | `pnpm build` |
| E2E | `pnpm exec playwright install --with-deps chromium` then `pnpm test:e2e` |

Local parity:

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
DEMO_MANAGER_CODES=1 DATABASE_URL="file:./dev.db" pnpm db:setup
pnpm test
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

## Manager setup

Manager view is unlocked with a **personal code**. Codes are stored as SHA-256 hashes in the `Manager` table and sessions are signed with `MANAGER_SESSION_SECRET`; neither value is returned to the client.

Before the first home-base setup, generate a private session secret and set it in the host's `.env`:

```bash
openssl rand -base64 48
# Copy the generated value into MANAGER_SESSION_SECRET in /opt/taco-oasis/.env
```

For an empty production database, set `INITIAL_MANAGER_NAME` and a four-or-more-character `INITIAL_MANAGER_CODE` in that same environment for the one `pnpm db:setup` run. Remove `INITIAL_MANAGER_CODE` immediately afterward. Use the Back office **Managers** tab to add the remaining managers, rotate codes, and deactivate the bootstrap manager if it is no longer needed.

`DEMO_MANAGER_CODES=1` creates development-only demo managers. CI and Playwright use it; a home base must not.

Idle timeout returns to **Staff** view after **15 seconds** without pointer/keyboard/touch (`MANAGER_IDLE_MS`, default `15000`). E2E sets a shorter value.

## Preferred go-live: SSH home-base

Configure these **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Required | Purpose |
| --- | --- | --- |
| `DEPLOY_HOST` | yes | Hostname or IP of home-base |
| `DEPLOY_USER` | yes | SSH user |
| `DEPLOY_SSH_KEY` | yes | Private key (PEM) for that user |
| `DEPLOY_PATH` | yes | Absolute app dir, e.g. `/opt/taco-oasis` |
| `DEPLOY_PORT` | no | SSH port (default `22`; can also be a repo **variable**) |
| `DEPLOY_SSH_KNOWN_HOSTS` | no | Pin host keys; otherwise `ssh-keyscan` / accept-new |
| `DEPLOY_HEALTHCHECK_URL` | yes for actual SSH go-live | Remote-localhost URL, e.g. `http://127.0.0.1:3000`, required and checked after restart |

**Runner note:** GitHub-hosted runners cannot reach a private LAN IP. Use a **self-hosted runner** on the venue LAN, or an SSH jump reachable from the internet.

### Home-base one-time setup

```bash
# On home-base (Ubuntu/Debian example)
sudo mkdir -p /opt/taco-oasis
sudo chown "$USER" /opt/taco-oasis
# Install Node 22 + enable pnpm via corepack
corepack enable
corepack prepare pnpm@10.33.3 --activate
sudo apt-get install -y sqlite3  # required for consistent deploy backups
# Optional systemd unit named taco-oasis (workflow restarts it if present)
```

After deploy, the workflow:

- extracts the artifact into `DEPLOY_PATH`
- creates a consistent SQLite backup in `DEPLOY_PATH/backups/<timestamp>-<sha>/` before extraction
- archives the prior artifact-shaped release in `DEPLOY_PATH/backups/release-*.tgz` when one exists
- restores the saved SQLite files after extraction
- runs `pnpm install`, `prisma generate`, `prisma db push`
- restarts `taco-oasis` systemd unit **or** `pnpm exec next start -H 0.0.0.0 -p 3000`

Manual fallback (same as go-live checklist):

```bash
pnpm i
cp .env.example .env   # DATABASE_URL="file:./prisma/prod.db" recommended for prod
INITIAL_MANAGER_NAME="Manager name" INITIAL_MANAGER_CODE="replace-this-code" pnpm db:setup  # first time only
pnpm build && pnpm start
```

## Optional: Vercel

Secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

**Warning:** SQLite on serverless is ephemeral and a poor fit for multi-tablet floor state. Prefer SSH home-base for Cashiers/Kitchen.

## Manual / dry-run

Actions → **CI + Go-live Deploy** → **Run workflow**:

- `dry_run: true` (default) — builds via quality job, downloads artifact, prints plan, **no remote writes**
- `dry_run: false` plus `confirm_go_live: DEPLOY` and configured secrets — real deploy

Rich's explicit go-live tap is required before entering that confirmation. A push or merge to `main` only runs quality gates and stores the artifact; it cannot deploy.

## Backup, restore, and rollback rehearsal

Before a live cutover, run this on the home base with the service stopped and record the exact backup directory and release archive in the go-live evidence:

```bash
cd /opt/taco-oasis
ls -lah backups
sudo systemctl stop taco-oasis
# In a disposable copy of the app directory, restore one backup and start it on a spare local port.
# Confirm the expected stations and one prior assignment are visible, then stop the rehearsal.
sudo systemctl start taco-oasis
```

If a deploy must be rolled back, stop the service, choose the matching `backups/release-*.tgz` and SQLite backup directory, then restore both before starting again:

```bash
cd /opt/taco-oasis
sudo systemctl stop taco-oasis
tar -xzf backups/release-<previous-sha>-<timestamp>.tgz -C .
cp -a backups/<timestamp>-<deploying-sha>/prod.db prisma/prod.db
rm -f prisma/prod.db-wal prisma/prod.db-shm
pnpm install --frozen-lockfile --prod=false
pnpm exec prisma generate
sudo systemctl start taco-oasis
curl -fsS http://127.0.0.1:3000 >/dev/null
```

Use the backup that immediately preceded the failed deployment. The restore rehearsal requires the actual home-base path and service unit, so it remains a go-live evidence gate until exercised there.

## Fail-fast behavior

- Deploy **never** runs if quality fails.
- Only a manually confirmed `workflow_dispatch` run can deploy; `main` pushes cannot write remotely.
- Missing deploy secrets → quality stays green; deploy job exits with a notice (not a failure).
