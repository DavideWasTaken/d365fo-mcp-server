/**
 * `doctor` on a git checkout compares against the branch, not the npm registry.
 *
 * package.json on a branch is only bumped by the release workflow at publish
 * time, so a checkout that already contains the latest release still reports
 * the previous version. Compared with the registry it was told "X is
 * available" forever, and the suggested `d365fo-mcp update` — a `git pull` —
 * could never clear the warning.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { checkCheckoutFreshness, checkSqlSwitch } from '../../src/cli/commands/doctor.js';
import { openStore, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';
import { cliCommand } from '../../src/cli/context.js';

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
    // The checkout's own entry point: a `d365fo-mcp` on PATH is either absent or
    // upstream's npm CLI, which would update a different installation.
    expect(result.fix).toBe(cliCommand('update'));
    expect(result.fix).toMatch(/^node ".*index\.js" update$/);
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

describe('doctor — SQL switch', () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'doctor-sql-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('warns when a server is configured but SQL is not enabled', () => {
    // A hand-edited config: the tool is then silently not published.
    const store = openStore(tmp, null);
    writeSetting(store, settingByPath('sql.server')!, '.');
    const result = checkSqlSwitch(store, 'Root');
    expect(result?.severity).toBe('warn');
    expect(result?.message).toContain('axdb_sql is not published');
    expect(result?.fix).toContain('config sql');
  });

  it('is quiet when SQL is enabled, or when no server is set', () => {
    const store = openStore(tmp, null);
    expect(checkSqlSwitch(store, 'Root')).toBeNull();
    writeSetting(store, settingByPath('sql.server')!, '.');
    writeSetting(store, settingByPath('sql.enabled')!, true);
    expect(checkSqlSwitch(store, 'Root')).toBeNull();
  });
});
