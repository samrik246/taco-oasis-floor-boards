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

- stops the app through its `taco-oasis` service or app-scoped pid file before changing a release or database
- reads the host `.env` and accepts only an absolute local SQLite URL, such as `file:/opt/taco-oasis/var/data/floor-boards.db`
- makes a consistent database backup in `DEPLOY_PATH/var/backups/<timestamp>-<sha>/` and archives the prior artifact-shaped release
- extracts the artifact without copying that backup over the live database; restoration is explicit rollback work only
- checks legacy duplicates, backfills assignment employee identity and import fingerprints, then applies the schema upgrade without `--accept-data-loss`
- runs install, Prisma generation, schema sync, and the manager/station/template readiness check
- starts `taco-oasis` or the direct Next Node entrypoint and checks `DEPLOY_HEALTHCHECK_URL`

An empty host needs owner-entered `MANAGER_SESSION_SECRET`, `INITIAL_MANAGER_NAME`, and `INITIAL_MANAGER_CODE` in `.env` before its first deploy. The bootstrap code is removed after the first manager is created. Demo mode remains off.

## Supported Mac home base

For the Taco Oasis Mac on the tablet LAN, use the packaged artifact locally. This path does not need GitHub secrets, SSH, a runner, or a registered system service.

```bash
cd /durable/path/to/taco-oasis-floor-boards
chmod +x scripts/home-base.sh
scripts/home-base.sh init "$PWD"
scripts/home-base.sh start "$PWD"
scripts/home-base.sh status "$PWD"
```

`init` asks at the Mac for the first manager name and code, generates the private session secret, writes mode-600 `.env`, creates durable `var/data`, `var/log`, `var/run`, and `var/backups` folders, initializes the database, validates both boards/stations/templates/managers, and removes the one-use bootstrap code.

Tablets open `http://MAC_LAN_IP:3000`. Keep the Mac powered, awake, and preferably on Ethernet. The tool only signals a process after it verifies the direct Floor Boards Node entrypoint; it refuses stale or foreign pid files and refuses to start while another process owns port 3000.

```bash
scripts/home-base.sh stop "$PWD"
scripts/home-base.sh restart "$PWD"
scripts/home-base.sh backup "$PWD"
scripts/home-base.sh restore "$PWD" /absolute/path/to/var/backups/<stamp>
scripts/home-base.sh launch-agent-template "$PWD"
```

The final command writes a per-user LaunchAgent template under the app's `var/run` folder but does not load it. After owner review, copy it to `~/Library/LaunchAgents/com.taco-oasis.floor-boards.plist` and load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.taco-oasis.floor-boards.plist`. The plist runs the foreground Floor Boards Node entrypoint directly; it does not call the backgrounding helper. `stop` and `restore` boot out that registered agent and verify port 3000 has no listener before replacing SQLite. This proves start-after-login only. Unattended reboot behavior remains a physical-Mac check for tomorrow; start-before-login needs a separately reviewed administrator LaunchDaemon.

### When I Work export at 07:00 and 16:00 (B2)

`scripts/wiw-export.ts` exports the current Friday-through-Thursday schedule from When I Work in its own headed Chromium, renames it to `Schedule_for_<friday>_<thursday>.xlsx` in `FLOOR_BOARDS_IMPORT_DIR`, and runs the folder import in hold mode. No AI agent runs it. Carve-out (CB-006): this job only; the weekly schedule and timesheet skills and the LOLA360 daily export stay supervised on Rich's Mac.

Settings, all absolute paths:

| Variable | What |
| --- | --- |
| `FLOOR_BOARDS_IMPORT_DIR` | The folder the export is saved in and imported from |
| `WIW_LOGIN_FILE` | The locked login file (below) |
| `WIW_BROWSER_PROFILE` | This job's own Chromium folder. Not the Tron Chrome profile |

`FLOOR_BOARDS_IMPORT_MODE` must be unset or `hold`: a change to a day already on the board waits for a manager's Confirm on the upload screen before the next run.

**Locked login file.** XICO fills it once on the Mac. It is outside the app folder (and so outside `var/`), outside the export and browser folders, never in git, and owned by the boards user with mode 600:

```text
email=<the When I Work sign-in email>
password=<its password>
```

```bash
chmod 600 /absolute/path/to/wiw-login
```

The script reads it only when the sign-in page is up, types the two fields, and clicks Sign in once. It never prints, logs, traces or screenshots them.

**Each run** writes one line per step to `var/log/wiw-export.log`: codes, counts and the file name only.

| Exit | Meaning | Workbook |
| --- | --- | --- |
| 0 | imported | deleted in the same run |
| 2 | held, `NEEDS_CONFIRM` | kept for Confirm on this Mac; the next run deletes it |
| 3 | refused (`DUPLICATE` is a clean no-change; `WRONG_WEEK`, `EMPTY`, `UNREADABLE`, `REFUSED` are stops) | deleted in the same run |
| 4 | no `Schedule_for_` file | none |
| 5 | stopped: `LOGIN`, `MFA`, `CAPTCHA` or `PAGE` (with a `reason=` code) | none saved |
| 1 | error | deleted after the error line |

A stop leaves the board on the last import. After `LOGIN` or `MFA`, sign in by hand once in the job's browser folder, then close the window:

```bash
FLOOR_BOARDS_IMPORT_DIR=… WIW_LOGIN_FILE=… WIW_BROWSER_PROFILE=… pnpm exec tsx scripts/wiw-export.ts --sign-in
```

**Timer.** Check the Mac's clock is America/Chicago, then write the LaunchAgent template (not loaded):

```bash
FLOOR_BOARDS_IMPORT_DIR=… WIW_LOGIN_FILE=… WIW_BROWSER_PROFILE=… pnpm exec tsx scripts/wiw-export.ts --launch-agent-template
```

It writes `var/run/com.taco-oasis.wiw-export.plist`: `StartCalendarInterval` 07:00 and 16:00, the boards user's GUI session only (the browser is headed). After review, copy it to `~/Library/LaunchAgents/` and load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.taco-oasis.wiw-export.plist`. If the Mac is asleep at a slot, launchd runs the job on wake, and missed slots become one run. The Playwright Chromium must be installed for the boards user (`pnpm exec playwright install chromium`).

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
ls -lah var/backups
sudo systemctl stop taco-oasis
# In a disposable copy of the app directory, restore one backup and start it on a spare local port.
# Confirm the expected stations and one prior assignment are visible, then stop the rehearsal.
sudo systemctl start taco-oasis
```

If a deploy must be rolled back, stop the service, choose the matching `var/backups/release-*.tgz` and SQLite backup directory, then restore both before starting again:

```bash
cd /opt/taco-oasis
sudo systemctl stop taco-oasis
tar -xzf var/backups/release-<previous-sha>-<timestamp>.tgz -C .
# database-path records the configured absolute SQLite location for this backup.
cp -a var/backups/<timestamp>-<deploying-sha>/database.db /absolute/path/from/database-path
rm -f /absolute/path/from/database-path-wal /absolute/path/from/database-path-shm
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
