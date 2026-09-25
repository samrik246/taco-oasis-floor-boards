#!/bin/sh
set -eu

case "${1:-}" in
  ''|--preflight-only) mode=preflight ;;
  --run-full-suite) mode=full ;;
  --watch) mode=watch ;;
  *) echo 'usage: sh scripts/validate-test-db-isolation.sh [--preflight-only|--run-full-suite|--watch]' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo 'too many arguments' >&2
  exit 2
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repo_dir"
temp_base=$(CDPATH= cd /tmp && pwd -P)
test_root=$(mktemp -d "$temp_base/color-boards-test-XXXXXXXX")
mkdir "$test_root/tmp"
export FLOOR_BOARDS_TEST_ROOT="$test_root"
export TMPDIR="$test_root/tmp"
export DATABASE_URL="file:$test_root/main.db"
export NODE_OPTIONS="--require=$repo_dir/scripts/test-db-guard.cjs"

# The preflight commands do not run tests. Their preloads prove the main Node
# process and the pnpm/tsx child route through a disposable SQLite path.
node -e 'process.stdout.write("main path checked\n")'
pnpm exec tsx scripts/test-db-probe.cjs child-tsx
main_push=$(pnpm exec prisma db push --skip-generate)
case "$main_push" in
  *"file:$test_root/main.db"*) echo "Prisma schema engine: $test_root/main.db" ;;
  *) echo 'Prisma schema engine main path mismatch' >&2; exit 1 ;;
esac
./node_modules/.bin/vitest --version
pnpm exec tsx tests/helpers/test-db-worker-setup.mts

# The integration tests create three distinct child databases under TMPDIR.
# Rehearse their URL overrides through pnpm/tsx and Prisma CLI without running
# their mutating test scripts or the package suite.
for child in c1-a18 seed-position-map planner-idle; do
  child_dir=$(mktemp -d "$TMPDIR/$child-XXXXXXXX")
  case "$child" in
    seed-position-map) child_db="$child_dir/seed-map.db" ;;
    *) child_db="$child_dir/home-base.db" ;;
  esac
  DATABASE_URL="file:$child_db" pnpm exec tsx scripts/test-db-probe.cjs "$child"
  case "$child" in
    c1-a18)
      cp tests/fixtures/schema-d02d812.prisma "$child_dir/schema.prisma"
      child_push=$(DATABASE_URL="file:$child_db" pnpm exec prisma db push --schema "$child_dir/schema.prisma" --skip-generate)
      ;;
    planner-idle)
      cp tests/fixtures/schema-7095442.prisma "$child_dir/schema.prisma"
      child_push=$(DATABASE_URL="file:$child_db" pnpm exec prisma db push --schema "$child_dir/schema.prisma" --skip-generate)
      ;;
    *) child_push=$(DATABASE_URL="file:$child_db" pnpm exec prisma db push --skip-generate) ;;
  esac
  case "$child_push" in
    *"file:$child_db"*) echo "Prisma schema engine: $child_db" ;;
    *) echo "Prisma schema engine $child path mismatch" >&2; exit 1 ;;
  esac
done

if DATABASE_URL=file:/Users/dan/.buzz/COLOR_BOARDS_APP/var/data/floor-boards.db node -e '' >/dev/null 2>&1; then
  echo 'installed database refusal failed' >&2
  exit 1
fi
echo "installed database refused"
if DATABASE_URL=file:./dev.db node -e '' >/dev/null 2>&1; then
  echo 'relative database refusal failed' >&2
  exit 1
fi
echo "relative database refused"
echo "path-only evidence: $test_root/database-paths.jsonl"

if [ "$mode" = full ] || [ "$mode" = watch ]; then
  # Seed only the disposable main database after every path has passed preflight.
  DEMO_MANAGER_CODES=1 pnpm exec tsx prisma/seed.ts
  export MANAGER_SESSION_SECRET='test-only-manager-session-secret-000000'
fi
if [ "$mode" = full ]; then
  exec ./node_modules/.bin/vitest run --reporter=dot
fi
if [ "$mode" = watch ]; then
  exec ./node_modules/.bin/vitest
fi
