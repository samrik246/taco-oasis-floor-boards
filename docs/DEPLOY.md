# Deploy / go-live — Taco Oasis Floor Boards

This app is a **Next.js + Prisma/SQLite** floor board meant for **LAN tablets** against a **home-base** host (MicroTouch / office PC). See the project go-live checklist: tablets open `http://HOME_BASE_IP:3000` in Chrome.

There is **no** in-repo `vercel.json`, `fly.toml`, or `Dockerfile`. CI therefore:

1. Always runs quality gates (`pnpm test`, `pnpm build`, Playwright e2e).
2. On `main` (and `workflow_dispatch`), uploads a production artifact.
3. Optionally deploys via **SSH/rsync** when `DEPLOY_*` secrets are set.
4. Optionally deploys to **Vercel** when `VERCEL_*` secrets are set (not preferred for SQLite floor use).

Workflow file: [`.github/workflows/ci-deploy.yml`](../.github/workflows/ci-deploy.yml)

## Quality gates (every PR + push to `main`)

| Step | Command / action |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` (pnpm **10.33.3**, Node **22**) |
| Prisma | `pnpm exec prisma generate` |
| Test DB | `DATABASE_URL=file:./dev.db pnpm db:setup` |
| Unit tests | `pnpm test` |
| Build | `pnpm build` |
| E2E | `pnpm exec playwright install --with-deps chromium` then `pnpm test:e2e` |

Local parity:

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
DATABASE_URL="file:./dev.db" pnpm db:setup
pnpm test
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

## Demo manager access codes

Manager view is unlocked with a **personal code**. Codes are stored as SHA-256 hashes in the `Manager` table (never plaintext in the client bundle). Seed creates these demo managers (`pnpm db:setup`):

| Manager | Demo code |
| --- | --- |
| Ana Rivera | `2468` |
| Luis Ortega | `1357` |
| Sam Chen | `8642` |

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
| `DEPLOY_HEALTHCHECK_URL` | no | e.g. `http://127.0.0.1:3000` checked on the remote after restart |

**Runner note:** GitHub-hosted runners cannot reach a private LAN IP. Use a **self-hosted runner** on the venue LAN, or an SSH jump reachable from the internet.

### Home-base one-time setup

```bash
# On home-base (Ubuntu/Debian example)
sudo mkdir -p /opt/taco-oasis
sudo chown "$USER" /opt/taco-oasis
# Install Node 22 + enable pnpm via corepack
corepack enable
corepack prepare pnpm@10.33.3 --activate
# Optional systemd unit named taco-oasis (workflow restarts it if present)
```

After deploy, the workflow:

- extracts the artifact into `DEPLOY_PATH`
- **preserves** existing `prisma/prod.db`
- runs `pnpm install`, `prisma generate`, `prisma db push`
- restarts `taco-oasis` systemd unit **or** `pnpm start` on `0.0.0.0:3000`

Manual fallback (same as go-live checklist):

```bash
pnpm i
cp .env.example .env   # DATABASE_URL="file:./prisma/prod.db" recommended for prod
pnpm db:setup          # first time only
pnpm build && pnpm start
```

## Optional: Vercel

Secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

**Warning:** SQLite on serverless is ephemeral and a poor fit for multi-tablet floor state. Prefer SSH home-base for Cashiers/Kitchen.

## Manual / dry-run

Actions → **CI + Go-live Deploy** → **Run workflow**:

- `dry_run: true` (default) — builds via quality job, downloads artifact, prints plan, **no remote writes**
- `dry_run: false` + secrets set — real deploy
- `force_deploy: true` — overrides dry-run when you intend a live push from the UI

## Fail-fast behavior

- Deploy **never** runs if quality fails.
- Overlapping PR workflow runs cancel; **main** runs do not cancel mid-deploy.
- Missing deploy secrets → quality stays green; deploy job exits with a notice (not a failure).
