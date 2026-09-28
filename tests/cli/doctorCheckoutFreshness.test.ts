/**
 * `doctor` on a git checkout compares against the branch, not the npm registry.
 *
 * package.json on a branch is only bumped by the release workflow at publish
 * time, so a checkout that already contains the latest release still reports
 * the previous version. Compared with the registry it was told "X is
 * available" forever, and the suggested `d365fo-mcp update` — a `git pull` —
 * could never clear the warning.
 */
import { describe, it, expect } from 'vitest';
import { checkCheckoutFreshness } from '../../src/cli/commands/doctor.js';

describe('doctor — checkout freshness', () => {
  it('is ok when the branch has nothing new upstream, whatever package.json says', () => {
    const result = checkCheckoutFreshness('1.17.4', { branch: 'main', upstream: 'origin/main', behind: 0 });

    expect(result.severity).toBe('ok');
    expect(result.message).toContain('main is up to date with origin/main');
    expect(result.message).not.toContain('is available');
    expect(result.fix).toBeUndefined();
  });

  it('warns and suggests update when the branch trails its upstream', () => {
    const result = checkCheckoutFreshness('1.17.4', { branch: 'main', upstream: 'origin/main', behind: 3 });

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('3 commits behind origin/main');
    expect(result.message).toContain('as of the last fetch');
    expect(result.fix).toBe('d365fo-mcp update');
  });

  it('uses the singular for one commit', () => {
    const result = checkCheckoutFreshness('1.17.4', { branch: 'main', upstream: 'origin/main', behind: 1 });

    expect(result.message).toContain('1 commit behind');
  });

  it('is informational when there is no upstream to compare with', () => {
    // Detached HEAD, a local-only branch, or git missing from PATH.
    const result = checkCheckoutFreshness('1.17.4', null);

    expect(result.severity).toBe('info');
    expect(result.fix).toBeUndefined();
  });
});
