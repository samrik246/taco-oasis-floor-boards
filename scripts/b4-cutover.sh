#!/usr/bin/env bash
# Packet-local foreground lock holder. Only the named operator runs this after judgment.
set -euo pipefail
packet="${1:?packet directory required}"
operation="${2:?install or rollback required}"
[[ "$operation" == install || "$operation" == rollback ]] || exit 2
packet="$(cd "$packet" && pwd)"
app=/Users/dan/.buzz/COLOR_BOARDS_APP
python3 "$packet/tools/b4_release.py" verify --packet "$packet" >/dev/null
source "$packet/tools/release-lock.sh"
acquire_release_lock "$app" 180 || { echo 'Release lock unavailable; no cutover performed.' >&2; exit 1; }
child=''
finish() { release_release_lock "$app"; echo "Shared release lock released $(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
forward() {
  trap '' INT TERM HUP
  if [[ -n "$child" ]]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" || true
  fi
  exit 130
}
trap finish EXIT
trap forward INT TERM HUP
python3 "$packet/tools/b4_release.py" cutover --packet "$packet" --operation "$operation" &
child=$!
result=0
wait "$child" || result=$?
child=''
exit "$result"
