import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStore, readSetting, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';
import { configureSql } from '../../src/cli/sqlSetup.js';
const { askSetting, info } = vi.hoisted(() => ({ askSetting: vi.fn(), info: vi.fn() }));
vi.mock('../../src/cli/settingsPrompt.js', () => ({ askSetting }));
vi.mock('../../src/cli/ui.js', () => ({ p: { log: { step: vi.fn(), info } } }));
afterEach(() => vi.clearAllMocks());
it('blank server disables SQL and skips all remaining questions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sql-setup-'));
  try {
    const store = openStore(dir, null);
    writeSetting(store, settingByPath('sql.enabled')!, true);
    askSetting.mockResolvedValueOnce(undefined);
    await configureSql(store);
    expect(askSetting).toHaveBeenCalledTimes(1);
    expect(readSetting(store, settingByPath('sql.enabled')!)).toBe(false);
    expect(readSetting(store, settingByPath('sql.allowWrites')!)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('asks server then database, writes and certificate only when chosen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sql-setup-'));
  try {
    const store = openStore(dir, null);
    askSetting.mockResolvedValueOnce('localhost').mockResolvedValueOnce('AxDB').mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await configureSql(store);
    expect(askSetting.mock.calls.map(c => c[1].path)).toEqual(['sql.server', 'sql.database', 'sql.allowWrites', 'sql.trustServerCertificate']);
    expect(readSetting(store, settingByPath('sql.enabled')!)).toBe(true);
    expect(info.mock.calls.flat().join(' ')).toContain('Windows');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
