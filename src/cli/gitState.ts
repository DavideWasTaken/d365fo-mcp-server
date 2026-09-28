/**
 * What a git checkout knows about itself — the checkout's answer to "is this
 * copy current?", which the npm registry cannot give.
 *
 * package.json on a branch is not bumped per release: the release workflow
 * stamps the version from the tag only at publish time, so a checkout that
 * already contains the latest release still reports the previous version, and
 * a registry comparison tells it to update forever. A checkout tracks a branch,
 * so the branch is what it is compared against.
 *
 * Everything here is advisory: a missing git, a detached HEAD or a branch with
 * no upstream returns null rather than throwing, like the registry check.
 */
import { execFileSync } from 'node:child_process';
import { repoRoot } from './context.js';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/** The commit the checkout is on, or null when git cannot tell. */
export function gitHead(): string | null {
  return git(['rev-parse', 'HEAD']);
}

/**
 * Files under `pathspec` that differ between two commits, or null when the
 * diff cannot be computed (unknown commit, git missing).
 */
export function changedFiles(from: string, to: string, pathspec: string): string[] | null {
  const out = git(['diff', '--name-only', from, to, '--', pathspec]);
  if (out === null) return null;
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

export interface BranchStatus {
  /** Local branch name. */
  branch: string;
  /** Upstream it tracks, e.g. origin/main. */
  upstream: string;
  /** Commits on the upstream that are not in HEAD, as of the last fetch. */
  behind: number;
}

/**
 * How far the checked-out branch trails its upstream.
 *
 * Deliberately reads the remote-tracking ref as the last fetch left it rather
 * than fetching: `doctor` must stay fast and work offline. The answer can
 * therefore be stale, and callers say "as of the last fetch".
 */
export function branchStatus(): BranchStatus | null {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return null;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream) return null;
  const count = git(['rev-list', '--count', 'HEAD..@{u}']);
  const behind = count === null ? Number.NaN : Number.parseInt(count, 10);
  if (!Number.isFinite(behind)) return null;
  return { branch, upstream, behind };
}
