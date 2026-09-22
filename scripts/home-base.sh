#!/usr/bin/env bash
# Local macOS home-base tool. It only manages files and one app-scoped process.
set -euo pipefail

usage() { echo "usage: $0 <init|start|stop|restart|backup|restore|status|launch-agent-template> APP_DIR [backup]" >&2; exit 2; }
command="${1:-}"; app="${2:-}"; [[ -n "${command}" && -n "${app}" ]] || usage
app="$(cd "${app}" && pwd)"
run="${app}/var/run"; log="${app}/var/log"; data="${app}/var/data"; backups="${app}/var/backups"; env_file="${app}/.env"; pid_file="${run}/floor-boards.pid"
launch_label="com.taco-oasis.floor-boards"
launch_domain="gui/$(id -u)"
launch_plist="${HOME}/Library/LaunchAgents/${launch_label}.plist"
die() { echo "home-base: $*" >&2; exit 1; }
dotenv_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "${value}"
}
node_entry="${app}/node_modules/next/dist/bin/next"
owns_pid() {
  local pid="$1" cwd
  cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [[ "${cwd}" == "${app}" ]]
}
owns_listener() {
  local pid="$1"
  lsof -nP -a -p "${pid}" -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1
}
launchd_manages_app() {
  command -v launchctl >/dev/null 2>&1 && launchctl print "${launch_domain}/${launch_label}" >/dev/null 2>&1
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
assert_no_listener() {
  if any_listener; then
    die "port 3000 still has a listener; refusing a database replacement"
  fi
  return 0
}
database_path() {
  local value
  value="$(sed -nE 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p' "${env_file}" | head -n 1)"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  [[ "${value}" == file:/* ]] || die "DATABASE_URL must be file:/absolute/path"
  printf '%s' "${value#file:}"
}
stop() {
  if launchd_manages_app; then
    launchctl bootout "${launch_domain}/${launch_label}" || die "could not stop the managed LaunchAgent"
    for _ in {1..20}; do
      if ! any_listener; then return 0; fi
      sleep 1
    done
    die "LaunchAgent listener remained after bootout"
  fi
  if [[ ! -f "${pid_file}" ]]; then
    assert_no_listener
    return
  fi
  local pid; pid="$(cat "${pid_file}")"
  owns_pid "${pid}" && owns_listener "${pid}" || die "pid file does not own this app listener; refusing to signal process ${pid}"
  kill "${pid}" 2>/dev/null || true
  for _ in {1..20}; do kill -0 "${pid}" 2>/dev/null || break; sleep 1; done
  kill -0 "${pid}" 2>/dev/null && die "app process ${pid} did not stop"
  assert_no_listener
  rm -f "${pid_file}"
}
start() {
  [[ -f "${env_file}" ]] || die "run init first"
  mkdir -p "${run}" "${log}"
  launchd_manages_app && die "LaunchAgent is already running"
  if [[ -f "${launch_plist}" ]]; then
    launchctl bootstrap "${launch_domain}" "${launch_plist}" || die "could not start the registered LaunchAgent"
    for _ in {1..20}; do launchd_manages_app && any_listener && return; sleep 1; done
    die "LaunchAgent did not become the listener"
  fi
  [[ -f "${node_entry}" ]] || die "Next entrypoint is missing; run init first"
  if [[ -f "${pid_file}" ]]; then
    pid="$(cat "${pid_file}")"
    owns_pid "${pid}" && owns_listener "${pid}" && die "already running"
    die "stale or foreign pid file; inspect ${pid_file} before replacing it"
  fi
  any_listener && die "port 3000 is already in use"
  (
    cd "${app}"
    nohup node "${node_entry}" start -H 0.0.0.0 -p 3000 >"${log}/floor-boards.log" 2>&1 &
    echo $! >"${pid_file}"
  )
  pid="$(cat "${pid_file}")"
  for _ in {1..20}; do owns_pid "${pid}" && owns_listener "${pid}" && return; sleep 1; done
  die "server did not become the app-owned listener; see ${log}/floor-boards.log"
}
case "${command}" in
  init)
    mkdir -p "${run}" "${log}" "${data}" "${backups}"
    [[ ! -f "${env_file}" ]] || die ".env exists; refusing to replace owner configuration"
    read -r -p "First manager name: " manager_name
    read -r -s -p "First manager code (4–64 characters): " manager_code; echo
    manager_code="$(printf '%s' "${manager_code}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ ${#manager_code} -ge 4 && ${#manager_code} -le 64 ]] || die "manager code must be 4–64 characters after trimming"
    session_secret="$(openssl rand -base64 48)"
    # Remove the one-use code whether bootstrap succeeds or fails. It never leaves this process as output.
    trap 'sed -i "" '\''s/^INITIAL_MANAGER_CODE=.*/INITIAL_MANAGER_CODE=""/'\'' "${env_file}" 2>/dev/null || true' EXIT
    cat >"${env_file}" <<EOF
DATABASE_URL="file:${data}/floor-boards.db"
MANAGER_SESSION_SECRET="${session_secret}"
INITIAL_MANAGER_NAME=$(dotenv_quote "${manager_name}")
INITIAL_MANAGER_CODE=$(dotenv_quote "${manager_code}")
EOF
    chmod 600 "${env_file}"
    (cd "${app}" && pnpm install --frozen-lockfile --prod=false && pnpm exec tsx scripts/upgrade-home-base.ts preflight && pnpm db:setup && pnpm exec tsx scripts/upgrade-home-base.ts backfill && pnpm exec tsx scripts/upgrade-home-base.ts enforce && pnpm exec tsx scripts/readiness-check.ts)
    trap - EXIT
    # Bootstrap code is one-use. Leave the manager record, never the code, on disk.
    sed -i '' 's/^INITIAL_MANAGER_CODE=.*/INITIAL_MANAGER_CODE=""/' "${env_file}"
    ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  backup)
    db="$(database_path)"; [[ -f "${db}" ]] || die "database does not exist"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "${backups}/${stamp}"
    sqlite3 "${db}" ".backup '${backups}/${stamp}/database.db'"
    printf '%s\n' "${db}" >"${backups}/${stamp}/database-path"
    echo "${backups}/${stamp}"
    ;;
  restore)
    backup="${3:-}"; [[ -f "${backup}/database.db" ]] || die "backup/database.db is required"
    stop; db="$(database_path)"; mkdir -p "$(dirname "${db}")"; cp -p "${backup}/database.db" "${db}"; rm -f "${db}-wal" "${db}-shm"; start
    ;;
  status)
    if launchd_manages_app; then
      owned_listener || die "LaunchAgent is managed but no app-owned listener is running"
      echo "running via LaunchAgent"
    elif [[ -f "${pid_file}" ]]; then
      pid="$(cat "${pid_file}")"
      owns_pid "${pid}" && owns_listener "${pid}" || die "pid file does not own an app listener"
      echo "running ${pid}"
    else
      assert_no_listener
      echo "stopped"
    fi
    ;;
  launch-agent-template)
    mkdir -p "${run}"
    node_path="$(command -v node)"
    cat >"${run}/com.taco-oasis.floor-boards.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.taco-oasis.floor-boards</string><key>ProgramArguments</key><array><string>${node_path}</string><string>${node_entry}</string><string>start</string><string>-H</string><string>0.0.0.0</string><string>-p</string><string>3000</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${app}</string><key>StandardOutPath</key><string>${log}/launchd.log</string><key>StandardErrorPath</key><string>${log}/launchd.log</string></dict></plist>
EOF
    echo "Generated ${run}/com.taco-oasis.floor-boards.plist (not loaded)."
    ;;
  *) usage ;;
esac
