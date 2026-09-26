#!/usr/bin/env bash
# Shared release lock (B2 + onsite installer, Rich 2A / Elliot's bar, 25 Sep
# 2026). Same directory, same claim-name format, same algorithm as
# src/lib/release-lock.ts: the lock is a directory, sibling to the app
# directory (outside every directory an installer extracts, replaces, or
# restores). Each attempt creates one claim file in it named
# `<pid>.<nonce>` (`set -o noclobber`, an atomic exclusive create), then
# lists the directory, and holds the lock only if its own claim is the only
# claim there; otherwise it withdraws its claim and waits. Two attempts each
# create before they list, so they can never both see themselves alone. The
# owner is the file NAME, written in the same atomic create, so a claim is
# never ownerless.
#
# A claim whose PID is no longer alive is stale: any attempt removes that
# exact claim file by name and tries again at once. Claim names are unique,
# so removing a stale name never removes a live claim. The lock frees itself
# when its holder is gone -- exit, an error, or a kill -- with no separate
# cleanup step required.
#
# Source this file, then, in the SAME process (a claim names this shell's
# own $$, so it must not hand off to a different process):
#
#   source "$(dirname "${BASH_SOURCE[0]}")/release-lock.sh"
#   acquire_release_lock "${DEPLOY_PATH}" 180 || { echo "..."; exit 1; }
#   trap 'release_release_lock "${DEPLOY_PATH}"' EXIT
#   # ... the install itself, including any restore-on-failure ...
#
# The `trap ... EXIT` covers a normal finish, a `set -e` abort, and an
# explicit `exit`. It does not run after `kill -9`, but that needs no
# handling here: the next acquire sees this dead PID and removes its claim.
set -euo pipefail

release_lock_path() {
  local app_dir="$1"
  printf '%s/%s\n' "$(dirname -- "${app_dir}")" ".taco-oasis-floor-boards-release.lock"
}

# Live if signalable, or if it exists but belongs to another user.
_release_lock_pid_alive() {
  kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

# _release_lock_attempt <lock-dir> <nonce>
# Prints held, busy, or retry (see src/lib/release-lock.ts attemptClaim).
# Returns non-zero on a real filesystem failure.
_release_lock_attempt() {
  local dir="$1" mine="$$.$2"
  mkdir -p -- "${dir}" || return 1
  (set -o noclobber; : >"${dir}/${mine}") || return 1
  local name others=() live=0
  for name in "${dir}"/*; do
    name="${name##*/}"
    [[ "${name}" =~ ^[1-9][0-9]*\.[A-Za-z0-9]+$ ]] || continue
    [[ "${name}" == "${mine}" ]] && continue
    others+=("${name}")
  done
  if (( ${#others[@]} == 0 )); then
    echo held
    return 0
  fi
  rm -f -- "${dir}/${mine}" || return 1
  for name in "${others[@]}"; do
    if _release_lock_pid_alive "${name%%.*}"; then
      live=1
    else
      rm -f -- "${dir}/${name}" || return 1
    fi
  done
  if (( live )); then echo busy; else echo retry; fi
}

# acquire_release_lock <app-dir> [wait-seconds]
# With no wait-seconds, waits as long as it takes. With one, gives up and
# returns 1 once that many seconds have passed against a still-live holder;
# this attempt's claim is withdrawn first, so nothing it wrote remains.
# Returns 2 on a real filesystem failure. Check the exit code.
acquire_release_lock() {
  local app_dir="$1" wait_s="${2:-}"
  local dir; dir="$(release_lock_path "${app_dir}")"
  local deadline=""
  [[ -n "${wait_s}" ]] && deadline=$(( $(date +%s) + wait_s ))
  local result nonce
  while true; do
    # Drawn here, in this shell and not the attempt's subshell, so RANDOM
    # advances and every attempt gets a fresh claim name.
    nonce="$(date +%s)${RANDOM}${RANDOM}${RANDOM}"
    result="$(_release_lock_attempt "${dir}" "${nonce}")" || return 2
    case "${result}" in
      held) return 0 ;;
      retry) continue ;;
    esac
    if [[ -n "${deadline}" ]] && (( $(date +%s) >= deadline )); then
      return 1
    fi
    # 0.5x-1.5x the poll interval (RELEASE_LOCK_POLL_MS, default 2000),
    # jittered so two waiters do not keep colliding.
    local poll_ms="${RELEASE_LOCK_POLL_MS:-2000}" ms
    ms=$(( poll_ms / 2 + RANDOM % (poll_ms + 1) ))
    sleep "$(( ms / 1000 )).$(printf '%03d' $(( ms % 1000 )))"
  done
}

# release_release_lock <app-dir>
# Removes only this process's own claims, so a run never deletes a claim
# another process has made.
release_release_lock() {
  local app_dir="$1"
  local dir; dir="$(release_lock_path "${app_dir}")"
  rm -f -- "${dir}/$$."* 2>/dev/null || true
  return 0
}
