#!/usr/bin/env bash
# Runs on the home-base host. Arguments arrive from the manually confirmed CI job.
set -euo pipefail

DEPLOY_PATH="${1:?absolute app path required}"
REMOTE_TGZ="${2:?artifact path required}"
HEALTHCHECK_URL="${3:?remote localhost health URL required}"
RELEASE_SHA="${4:?release SHA required}"
RUN_DIR="${DEPLOY_PATH}/var/run"
LOG_DIR="${DEPLOY_PATH}/var/log"
BACKUP_DIR="${DEPLOY_PATH}/var/backups"
NODE_ENTRY="${DEPLOY_PATH}/node_modules/next/dist/bin/next"

die() { echo "deploy: $*" >&2; exit 1; }
owns_pid() {
  local pid="$1" cwd
  if [[ -L "/proc/${pid}/cwd" ]]; then
    cwd="$(readlink "/proc/${pid}/cwd")"
  else
    cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  fi
  [[ "${cwd}" == "${DEPLOY_PATH}" ]]
}

owns_listener() {
  local pid="$1"
  lsof -nP -a -p "${pid}" -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1
}

any_listener() {
  lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1
}

owned_listener() {
  local candidate
  for candidate in $(lsof -nP -t -iTCP:3000 -sTCP:LISTEN 2>/dev/null || true); do
    owns_pid "${candidate}" && return 0
  done
  return 1
}

wait_for_no_listener() {
  for _ in {1..20}; do
    if ! any_listener; then return 0; fi
    sleep 1
  done
  die "port 3000 still has a listener after stop; refusing release or database changes"
}

wait_for_owned_listener() {
  for _ in {1..20}; do
    if owned_listener; then return 0; fi
    sleep 1
  done
  die "app-owned listener did not start; refusing to accept an unrelated port-3000 process"
}

read_database_url() {
  local value
  value="$(sed -nE 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p' "${DEPLOY_PATH}/.env" | head -n 1)"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  [[ "${value}" == file:/* ]] || die "DATABASE_URL must be an absolute local SQLite file URL (file:/absolute/path)."
  printf '%s' "${value#file:}"
}

clear_bootstrap_code() {
  local replacement
  replacement="$(mktemp "${DEPLOY_PATH}/.env.XXXXXX")"
  awk 'BEGIN { changed = 0 } /^INITIAL_MANAGER_CODE=/ { print "INITIAL_MANAGER_CODE=\"\""; changed = 1; next } { print } END { if (!changed) print "INITIAL_MANAGER_CODE=\"\"" }' "${DEPLOY_PATH}/.env" >"${replacement}"
  chmod 600 "${replacement}"
  mv "${replacement}" "${DEPLOY_PATH}/.env"
}

stop_app() {
  if systemctl cat taco-oasis >/dev/null 2>&1; then
    sudo systemctl stop taco-oasis
    wait_for_no_listener
    SERVICE_MODE=systemd
    return
  fi
  SERVICE_MODE=pidfile
  local pid_file="${RUN_DIR}/floor-boards.pid"
  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}")"
    owns_pid "${pid}" && owns_listener "${pid}" || die "pid file does not own this app listener; refusing to signal process ${pid}"
    kill "${pid}" 2>/dev/null || true
    for _ in {1..20}; do kill -0 "${pid}" 2>/dev/null || break; sleep 1; done
    kill -0 "${pid}" 2>/dev/null && die "app process ${pid} did not stop"
    rm -f "${pid_file}"
    wait_for_no_listener
  elif [[ -f "${DEPLOY_PATH}/RELEASE_SHA" ]]; then
    die "existing release has no taco-oasis service or app-scoped pid file; refusing an unsafe deploy"
  fi
}

start_app() {
  if [[ "${SERVICE_MODE}" == systemd ]]; then
    sudo systemctl start taco-oasis
    wait_for_owned_listener
    return
  fi
  mkdir -p "${RUN_DIR}" "${LOG_DIR}"
  [[ -f "${NODE_ENTRY}" ]] || die "Next entrypoint is missing after install"
  any_listener && die "port 3000 is already in use; refusing to start alongside an unrelated listener"
  (
    nohup node "${NODE_ENTRY}" start -H 0.0.0.0 -p 3000 >"${LOG_DIR}/floor-boards.log" 2>&1 &
    echo $! >"${RUN_DIR}/floor-boards.pid"
  )
  local pid
  pid="$(cat "${RUN_DIR}/floor-boards.pid")"
  for _ in {1..20}; do
    if owns_pid "${pid}" && owns_listener "${pid}"; then return 0; fi
    sleep 1
  done
  die "new pid file does not own the app listener"
}

wait_for_health() {
  for _ in {1..20}; do
    if curl -fsS "${HEALTHCHECK_URL}" >/dev/null; then return; fi
    sleep 1
  done
  die "health check did not pass after restart"
}

mkdir -p "${DEPLOY_PATH}" "${BACKUP_DIR}" "${RUN_DIR}" "${LOG_DIR}"
if [[ ! -f "${DEPLOY_PATH}/.env" ]]; then
  mkdir -p "${DEPLOY_PATH}/var/data"
  cat >"${DEPLOY_PATH}/.env" <<EOF
DATABASE_URL="file:${DEPLOY_PATH}/var/data/floor-boards.db"
MANAGER_SESSION_SECRET=""
INITIAL_MANAGER_NAME=""
INITIAL_MANAGER_CODE=""
EOF
  chmod 600 "${DEPLOY_PATH}/.env"
fi

DB_PATH="$(read_database_url)"
mkdir -p "$(dirname "${DB_PATH}")"
stop_app

BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_SHA}"
if [[ -f "${DB_PATH}" ]]; then
  mkdir -p "${BACKUP_DIR}/${BACKUP_STAMP}"
  command -v sqlite3 >/dev/null || die "sqlite3 is required for a consistent backup"
  sqlite3 "${DB_PATH}" ".backup '${BACKUP_DIR}/${BACKUP_STAMP}/database.db'"
  printf '%s\n' "${DB_PATH}" >"${BACKUP_DIR}/${BACKUP_STAMP}/database-path"
  printf '%s\n' "${RELEASE_SHA}" >"${BACKUP_DIR}/${BACKUP_STAMP}/deploying-sha"
fi
if [[ -f "${DEPLOY_PATH}/RELEASE_SHA" ]]; then
  previous_sha="$(cat "${DEPLOY_PATH}/RELEASE_SHA")"
  test -f "${DEPLOY_PATH}/.artifact-files" || die "prior release manifest is missing"
  tar -czf "${BACKUP_DIR}/release-${previous_sha}-${BACKUP_STAMP}.tgz" -C "${DEPLOY_PATH}" -T "${DEPLOY_PATH}/.artifact-files"
fi

tar -xzf "${REMOTE_TGZ}" -C "${DEPLOY_PATH}"
cd "${DEPLOY_PATH}"
corepack enable || true
pnpm install --frozen-lockfile --prod=false
pnpm exec prisma generate
pnpm exec tsx scripts/upgrade-home-base.ts preflight
pnpm exec tsx scripts/upgrade-home-base.ts prepare
pnpm exec tsx scripts/upgrade-home-base.ts backfill
pnpm exec tsx scripts/upgrade-home-base.ts enforce
pnpm exec prisma db push
if ! pnpm exec tsx scripts/readiness-check.ts; then
  pnpm db:setup
  # The bootstrap code is one-use; keep the created manager, never its code.
  clear_bootstrap_code
  pnpm exec tsx scripts/upgrade-home-base.ts backfill
  pnpm exec tsx scripts/upgrade-home-base.ts enforce
  pnpm exec tsx scripts/readiness-check.ts
fi
start_app
wait_for_health
rm -f "${REMOTE_TGZ}"
echo "Deployed ${RELEASE_SHA}; database preserved at ${DB_PATH}; backup ${BACKUP_DIR}/${BACKUP_STAMP}"
