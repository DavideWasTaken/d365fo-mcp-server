#!/usr/bin/env bash
# Deletes this fork's branches whose pull request is merged or closed and that
# still point at the commit the pull request ended with. See the prune-branches
# job in .github/workflows/sync-upstream.yml for the rules.
#
# Env: GITHUB_REPOSITORY (the fork), UPSTREAM_REPO, GH_TOKEN, DRY_RUN=true to
# only report, GITHUB_STEP_SUMMARY (optional).
set -euo pipefail

fork="$GITHUB_REPOSITORY"
owner="${fork%%/*}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
deleted=() kept=() no_pr=()

# PRs whose head is this branch of this fork: upstream PRs opened from the fork,
# and the fork's own PRs. --head matches the branch name in any repository, so
# upstream results are narrowed to this owner.
prs_for() {
  {
    gh pr list -R "$UPSTREAM_REPO" --head "$1" --state all --limit 50 \
      --json number,state,headRefOid,headRepositoryOwner,url \
      -q ".[] | select(.headRepositoryOwner.login == \"$owner\") | [.number, .state, .headRefOid, .url] | @tsv"
    gh pr list -R "$fork" --head "$1" --state all --limit 50 \
      --json number,state,headRefOid,url \
      -q '.[] | [.number, .state, .headRefOid, .url] | @tsv'
  }
}

while read -r branch sha; do
  case "$branch" in main|sync/upstream-*) continue ;; esac
  prs=$(prs_for "$branch")
  if [ -z "$prs" ]; then
    no_pr+=("\`$branch\`")
    continue
  fi
  if awk -F'\t' '$2 == "OPEN"' <<< "$prs" | grep -q .; then
    kept+=("\`$branch\`: open PR $(awk -F'\t' '$2 == "OPEN" { print $4; exit }' <<< "$prs")")
    continue
  fi
  done_pr=$(awk -F'\t' -v sha="$sha" '$3 == sha { print $4 " (" tolower($2) ")"; exit }' <<< "$prs")
  if [ -z "$done_pr" ]; then
    kept+=("\`$branch\`: has commits after its PR $(head -n 1 <<< "$prs" | cut -f4)")
    continue
  fi
  if [ "${DRY_RUN:-false}" = true ]; then
    deleted+=("\`$branch\`: $done_pr (test run, not deleted)")
  elif gh api -X DELETE "repos/$fork/git/refs/heads/$branch" > /dev/null; then
    deleted+=("\`$branch\`: $done_pr")
  else
    kept+=("\`$branch\`: delete failed")
  fi
done < <(gh api "repos/$fork/branches" --paginate -q '.[] | "\(.name) \(.commit.sha)"')

{
  echo '### Fork branches'
  list() { if [ $# -eq 0 ]; then echo '- none'; else printf -- '- %s\n' "$@"; fi; }
  echo; echo '**Deleted** (PR merged or closed, no commits after it)'; list "${deleted[@]+"${deleted[@]}"}"
  echo; echo '**Kept**'; list "${kept[@]+"${kept[@]}"}"
  echo; echo '**No PR** (kept; look at these)'; list "${no_pr[@]+"${no_pr[@]}"}"
} >> "$summary"
