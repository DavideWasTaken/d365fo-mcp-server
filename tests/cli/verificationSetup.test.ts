/**
 * UI URL and SQL are asked after the environment type: a classic VM offers its
 * AOS web.config values, a UDE machine has neither a web.config nor a local
 * AxDB reachable with Windows authentication, so SQL is not asked there.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStore } from '../../src/cli/settingsStore.js';

const { askSetting, configureSql, info } = vi.hoisted(() => ({ askSetting: vi.fn(), configureSql: vi.fn(), info: vi.fn() }));
vi.mock('../../src/cli/settingsPrompt.js', () => ({ askSetting }));
vi.mock('../../src/cli/sqlSetup.js', () => ({ configureSql }));
vi.mock('../../src/cli/ui.js', () => ({ p: { log: { step: vi.fn(), info } } }));
const { configureVerification } = await import('../../src/cli/verificationSetup.js');

let root: string | undefined;
afterEach(() => {
  vi.clearAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function store() {
  root = fs.mkdtempSync(join(tmpdir(), 'verification-setup-'));
  return openStore(root, null);
}

it('offers the AOS URL and hands the web.config database to the SQL step on a classic VM', async () => {
  const target = store();
  const packages = join(root!, 'AosService', 'PackagesLocalDirectory');
  fs.mkdirSync(packages, { recursive: true });
  fs.mkdirSync(join(root!, 'AosService', 'WebRoot'));
  fs.writeFileSync(join(root!, 'AosService', 'WebRoot', 'web.config'),
    '<add key="Infrastructure.HostUrl" value="https://usnconeboxax1aos.cloud.onebox.dynamics.com/" />' +
    '<add key="DataAccess.DbServer" value="." /><add key="DataAccess.Database" value="AxDB" />');

  await configureVerification(target, 'traditional', packages);

  expect(askSetting.mock.calls.map(c => c[1].path)).toEqual(['environment.uiTestUrl']);
  expect(askSetting.mock.calls[0][2]).toEqual({ initial: 'https://usnconeboxax1aos.cloud.onebox.dynamics.com/' });
  expect(configureSql).toHaveBeenCalledWith(target, expect.objectContaining({ dbServer: '.', database: 'AxDB' }));
});

it('does not ask for the browser: auto already falls back from Chromium to Edge', async () => {
  await configureVerification(store(), 'traditional', undefined);
  expect(askSetting.mock.calls.map(c => c[1].path)).not.toContain('environment.uiBrowserChannel');
});

it('asks only the URL on UDE, with nothing to offer, and skips SQL', async () => {
  await configureVerification(store(), 'ude');
  expect(askSetting.mock.calls.map(c => c[1].path)).toEqual(['environment.uiTestUrl']);
  expect(askSetting.mock.calls[0][2]).toEqual({ initial: undefined });
  expect(configureSql).not.toHaveBeenCalled();
  expect(info.mock.calls.flat().join(' ')).toContain('config sql');
});
