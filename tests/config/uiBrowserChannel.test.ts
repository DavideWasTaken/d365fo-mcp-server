import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { settingByPath } from '../../src/config/settings.js';
import { openStore, saveStore, writeSetting } from '../../src/cli/settingsStore.js';
import { resolveConfigFiles, toEnvRecord } from '../../src/config/configFile.js';
import { resolveUiProfile } from '../../src/tools/sdlc/uiVerification/profile.js';
import { loadEnv } from '../../src/utils/loadEnv.js';

afterEach(() => vi.unstubAllEnvs());

it('persists the optional browser choice through normal configuration', () => {
  const setting = settingByPath('environment.uiBrowserChannel');
  expect(setting?.choices?.map(c => c.value)).toEqual(['auto', 'chromium', 'msedge']);
  const dir = mkdtempSync(join(tmpdir(), 'ui-channel-'));
  try {
    const store = openStore(dir, null);
    writeSetting(store, setting!, 'msedge');
    saveStore(store);
    expect(toEnvRecord(resolveConfigFiles(dir, { allowEnvOverride: false })).D365FO_UI_BROWSER_CHANNEL).toBe('msedge');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('maps setup browser choice while keeping explicit profiles independent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-profile-channel-'));
  try {
    vi.stubEnv('D365FO_UI_TEST_URL', 'https://test.example');
    vi.stubEnv('D365FO_UI_STORAGE_STATE', join(dir, 'auth.json'));
    vi.stubEnv('D365FO_UI_OUTPUT_DIR', join(dir, 'reports'));
    vi.stubEnv('D365FO_UI_BROWSER_CHANNEL', 'msedge');
    expect((await resolveUiProfile()).channel).toBe('msedge');
    const file = join(dir, 'profile.json');
    writeFileSync(
      file,
      JSON.stringify({ baseUrl: 'https://other.example', storageState: 'auth.json', outputDir: 'reports' }),
    );
    expect((await resolveUiProfile(file)).channel).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects invalid setup browser channels before launching', async () => {
  vi.stubEnv('D365FO_UI_TEST_URL', 'https://test.example');
  vi.stubEnv('D365FO_UI_STORAGE_STATE', join(tmpdir(), 'auth.json'));
  vi.stubEnv('D365FO_UI_OUTPUT_DIR', join(tmpdir(), 'reports'));
  vi.stubEnv('D365FO_UI_BROWSER_CHANNEL', 'unsupported');
  await expect(resolveUiProfile()).rejects.toThrow();
});

it('does not inherit an ambient installation browser choice into a selected instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-channel-isolation-'));
  const original = { ...process.env };
  try {
    const instance = join(dir, 'instances', 'other');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'd365fo-mcp.json'), '{}');
    writeFileSync(join(dir, '.env'), 'D365FO_UI_BROWSER_CHANNEL=msedge\n');
    delete process.env.ENV_FILE;
    delete process.env.D365FO_UI_BROWSER_CHANNEL;
    process.env.D365FO_CONFIG = join(instance, 'd365fo-mcp.json');
    loadEnv(pathToFileURL(join(dir, 'src', 'index.ts')).href);
    expect(process.env.D365FO_UI_BROWSER_CHANNEL).toBeUndefined();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(dir, { recursive: true, force: true });
  }
});
