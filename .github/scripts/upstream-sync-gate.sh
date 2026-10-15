#!/usr/bin/env bash
# The checks a merged tree must pass before the upstream sync pushes it to
# main: the VM-free gates of ci.yml and eval-gate.yml. Every check runs, so one
# report lists all failures. Exit status 1 when any failed.
#
# Usage: upstream-sync-gate.sh <log file>
#
# Not checked: bridge/build-attestation.json. It can only be refreshed by
# compiling the bridge on a D365FO VM (`npm run bridge:build`); the workflow
# reports a stale one instead of refusing the sync for it.
set -uo pipefail

log="${1:?usage: upstream-sync-gate.sh <log file>}"
mkdir -p "$(dirname "$log")"
: > "$log"
failed=()

check() {
  local name="$1"; shift
  echo "::group::$name"
  echo "=== $name: $*" >> "$log"
  if "$@" >> "$log" 2>&1; then
    echo "=== $name: passed" >> "$log"
  else
    echo "=== $name: FAILED" >> "$log"
    failed+=("$name")
  fi
  echo "::endgroup::"
}

# A merge that changed the lockfile needs the merged dependencies, not the ones
# installed for the fork's previous main.
if ! git diff --quiet HEAD -- package-lock.json; then
  check 'npm ci' npm ci --no-audit --no-fund
fi
check 'typecheck'          npm run typecheck
check 'lint'               npm run lint
check 'config docs'        npm run config:docs -- --check
check 'build'              npm run build
check 'unit tests'         npx vitest run
check 'integration tests'  npm run test:integration
check 'knowledge audit'    npm run eval:knowledge-audit
check 'coverage matrix'    npm run eval:coverage -- --check

if [ ${#failed[@]} -gt 0 ]; then
  printf 'Failed checks: %s\n' "${failed[*]}" | tee -a "$log"
  exit 1
fi
echo 'All checks passed.' | tee -a "$log"
