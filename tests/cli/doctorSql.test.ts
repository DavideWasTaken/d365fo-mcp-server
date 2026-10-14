/**
 * `d365fo-mcp doctor` — a SQL server configured while SQL stays off.
 *
 * axdb_sql is published only when sql.enabled is true and a server is set. The
 * wizard writes both, but a hand-edited config can carry the server alone, and
 * then the tool is silently absent.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSqlSwitch } from '../../src/cli/commands/doctor.js';
import { openStore, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';

describe('doctor — SQL switch', () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'doctor-sql-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const store = (enabled?: unknown, server?: string) => {
    const s = openStore(fs.mkdtempSync(join(tmp, 's-')), null);
    if (server !== undefined) writeSetting(s, settingByPath('sql.server')!, server);
    if (enabled !== undefined) writeSetting(s, settingByPath('sql.enabled')!, enabled);
    return s;
  };

  it('warns when a server is configured but SQL is not enabled', () => {
    for (const s of [store(undefined, '.'), store(false, 'SQLHOST')]) {
      const result = checkSqlSwitch(s, 'Root');
      expect(result?.severity).toBe('warn');
      expect(result?.message).toContain('axdb_sql is not published');
      expect(result?.fix).toContain('config sql');
    }
  });

  it('is quiet when SQL is enabled, or when no server is set', () => {
    expect(checkSqlSwitch(store(), 'Root')).toBeNull();
    expect(checkSqlSwitch(store(false), 'Root')).toBeNull();
    expect(checkSqlSwitch(store(undefined, '   '), 'Root')).toBeNull();
    expect(checkSqlSwitch(store(true, '.'), 'Root')).toBeNull();
    // The runtime reads the same values the env way: "true", "1", "yes", "on".
    expect(checkSqlSwitch(store('true', '.'), 'Root')).toBeNull();
  });
});
