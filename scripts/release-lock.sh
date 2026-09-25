#!/usr/bin/env bash
# Shared release lock (B2 + onsite installer, Rich 2A / Elliot's bar, 25 Sep
# 2026). Same file, same file format, same algorithm as src/lib/release-lock.ts:
# one file holding the holder's PID as text, at a path outside every
# directory an installer extracts, replaces, or restores. Claiming is an
# atomic exclusive create (`set -o noclobber`, POSIX-atomic, the bash
# equivalent of Node's `open(file, "wx")`), so two processes racing for a
# free lock cannot both win. A held lock is proven live with `kill -0`; a
# dead holder's lock is stale and is reclaimed immediately, no wait. This is
# process-liveness locking (the mechanism behind the classic Unix `shlock`):
# the lock frees itself the moment its holder is gone -- exit, an error, or
# a kill -- with no separate cleanup step required.
#
# Source this file, then, in the SAME process (the lock is held by this
# shell's own $$, so it must not hand off to a different process without
# re-registering):
#
#   source "$(dirname "${BASH_SOURCE[0]}")/release-lock.sh"
#   acquire_release_lock "${DEPLOY_PATH}" 180 || { echo "..."; exit 1; }
#   trap 'release_release_lock "${DEPLOY_PATH}"' EXIT
#   # ... the install itself, including any restore-on-failure ...
#
# The `trap ... EXIT` covers a normal finish, a `set -e` abort, and an
# explicit `exit`. It does not run after `kill -9`, but that needs no
# handling here: the next acquire sees this dead PID and reclaims at once.
set -euo pipefail

release_lock_path() {
  local app_dir="$1"
  printf '%s/%s\n' "$(dirname -- "${app_dir}")" ".taco-oasis-floor-boards-release.lock"
}

# acquire_release_lock <app-dir> [wait-seconds]
# With no wait-seconds, waits as long as it takes. With one, gives up and
# returns 1 once that many seconds have passed against a still-live holder;
# the lock file is untouched in that case. Check the exit code.
acquire_release_lock() {
  local app_dir="$1" wait_s="${2:-}"
  local file; file="$(release_lock_path "${app_dir}")"
  local deadline=""
  [[ -n "${wait_s}" ]] && deadline=$(( $(date +%s) + wait_s ))
  while true; do
    if (set -o noclobber; printf '%s' "$$" >"${file}") 2>/dev/null; then
      return 0
    fi
    local holder
    holder="$(cat "${file}" 2>/dev/null || true)"
    if [[ -z "${holder}" ]] || ! kill -0 "${holder}" 2>/dev/null; then
      rm -f "${file}"
      continue
    fi
    if [[ -n "${deadline}" ]] && (( $(date +%s) >= deadline )); then
      return 1
    fi
    sleep 2
  done
}

# release_release_lock <app-dir>
# Removes the file only if it still names this process (compare-and-delete),
# so a run never deletes a lock a later run has since claimed.
release_release_lock() {
  local app_dir="$1"
  local file; file="$(release_lock_path "${app_dir}")"
  local holder
  holder="$(cat "${file}" 2>/dev/null || true)"
  [[ "${holder}" == "$$" ]] && rm -f "${file}"
  return 0
}
