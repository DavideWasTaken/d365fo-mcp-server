import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPathEnv, resolveConfigFiles, toEnvRecord } from '../../src/config/configFile.js';
import { settingByPath } from '../../src/config/settings.js';
import { openStore, saveStore, writeSetting } from '../../src/cli/settingsStore.js';
import { InputSchema, ProfileSchema, examplePlan } from '../../src/tools/sdlc/uiVerification/contract.js';
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
import { loadEnv } from '../../src/utils/loadEnv.js';
import { resolveUiProfile } from '../../src/tools/sdlc/uiVerification/profile.js';

afterEach(() => vi.unstubAllEnvs());

describe('UI test configuration', () => {
  it('does not inherit UI URL or login from another installation ambient .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-isolation-'));
    const original = { ...process.env };
    try {
      const instance = join(dir, 'instances', 'other');
      mkdirSync(instance, { recursive: true });
      writeFileSync(join(instance, 'd365fo-mcp.json'), '{}');
      writeFileSync(join(dir, '.env'), 'D365FO_UI_TEST_URL=https://wrong.example\nD365FO_UI_STORAGE_STATE=wrong-auth.json\nD365FO_UI_OUTPUT_DIR=wrong-reports\n');
      for (const key of ['ENV_FILE', 'D365FO_UI_TEST_URL', 'D365FO_UI_STORAGE_STATE', 'D365FO_UI_OUTPUT_DIR']) delete process.env[key];
      process.env.D365FO_CONFIG = join(instance, 'd365fo-mcp.json');
      loadEnv(pathToFileURL(join(dir, 'src', 'index.ts')).href);
      expect(process.env.D365FO_UI_TEST_URL).toBeUndefined();
      expect(process.env.D365FO_UI_STORAGE_STATE).toBe(join(instance, '.d365fo-ui', 'auth.json'));
      expect(process.env.D365FO_UI_OUTPUT_DIR).toBe(join(instance, '.d365fo-ui', 'reports'));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('persists the URL and resolves auth/report defaults separately for each instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-config-'));
    try {
      const store = openStore(dir, null);
      const setting = settingByPath('environment.uiTestUrl');
      expect(setting).toBeDefined();
      writeSetting(store, setting!, 'https://test.example');
      saveStore(store);
      const files = resolveConfigFiles(dir, { allowEnvOverride: false });
      const env = { ...defaultPathEnv(files.baseDir), ...toEnvRecord(files) };
      expect(env.D365FO_UI_TEST_URL).toBe('https://test.example');
      expect(env.D365FO_UI_STORAGE_STATE).toBe(join(dir, '.d365fo-ui', 'auth.json'));
      expect(env.D365FO_UI_OUTPUT_DIR).toBe(join(dir, '.d365fo-ui', 'reports'));
      expect(defaultPathEnv(join(dir, 'second')).D365FO_UI_STORAGE_STATE).not.toBe(env.D365FO_UI_STORAGE_STATE);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('allows skipping UI setup but rejects invalid or credential-bearing URLs', () => {
    const setting = settingByPath('environment.uiTestUrl');
    expect(setting).toBeDefined();
    const validate = setting!.validate!;
    for (const value of ['', 'https://test.example', 'HTTPS://test.example', 'http://localhost:9000/?cmp=USMF'])
      expect(validate(value)).toBeUndefined();
    expect(ProfileSchema.safeParse({ baseUrl: 'HTTPS://test.example', storageState: 'auth.json', outputDir: 'reports' }).success).toBe(true);
    for (const value of ['not-a-url', 'file:///test', 'https://user:secret@test.example'])
      expect(validate(value)).toBeTruthy();
  });

  it('asks the agent to request the URL only when a test is attempted without one', async () => {
    const input = { action: 'run', plan: examplePlan };
    expect(InputSchema.safeParse(input).success).toBe(true);
    vi.stubEnv('D365FO_UI_TEST_URL', '');
    const result = await verifyUiCustomizationTool(input);
    const reply = JSON.parse(result.content[0].text);
    expect(reply.status).toBe('NOT_VERIFIED');
    expect(reply.requiresUserInput).toBe(true);
    expect(reply.missingField).toBe('environmentUrl');
    expect(reply.question).toContain('URL');
    expect(reply.nextAction).toContain('Ask the user');
    expect(reply.nextAction).toContain('skip');
  });

  it('uses a one-run URL answer without modifying the configured environment', async () => {
    vi.stubEnv('D365FO_UI_TEST_URL', '');
    vi.stubEnv('D365FO_UI_STORAGE_STATE', join(tmpdir(), 'auth.json'));
    vi.stubEnv('D365FO_UI_OUTPUT_DIR', join(tmpdir(), 'reports'));
    const profile = await resolveUiProfile(undefined, 'https://answer.example');
    expect(profile.baseUrl).toBe('https://answer.example');
    expect(process.env.D365FO_UI_TEST_URL).toBe('');
    vi.stubEnv('D365FO_UI_TEST_URL', 'https://configured.example');
    expect((await resolveUiProfile(undefined, 'https://answer.example')).baseUrl).toBe('https://configured.example');
    expect(InputSchema.safeParse({ action: 'run', plan: examplePlan, environmentUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(InputSchema.safeParse({ action: 'run', plan: examplePlan, environmentUrl: 'not-a-url' }).success).toBe(false);
    expect(InputSchema.safeParse({ action: 'run', plan: examplePlan, environmentUrl: 'https://user:secret@example.com' }).success).toBe(false);
  });
});
