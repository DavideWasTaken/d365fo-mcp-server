import { afterEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { GuidedBrowser } from '../../src/tools/sdlc/uiVerification/guided/browserSession.js';
import { authenticateUi } from '../../src/tools/sdlc/uiVerification/authenticate.js';
import { allowedNavigationUrl } from '../../src/tools/sdlc/uiVerification/navigation.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchUiBrowser } from '../../src/tools/sdlc/uiVerification/browserLaunch.js';
import { safeUiDiagnostic } from '../../src/tools/sdlc/uiVerification/diagnostics.js';
import { defaultAuthenticationOrigins } from '../../src/tools/sdlc/uiVerification/navigation.js';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
function configure(channel = 'auto') {
  vi.stubEnv('D365FO_UI_TEST_URL', 'https://test.example');
  vi.stubEnv('D365FO_UI_STORAGE_STATE', join(tmpdir(), 'missing-ui-channel-auth.json'));
  vi.stubEnv('D365FO_UI_OUTPUT_DIR', join(tmpdir(), 'reports'));
  vi.stubEnv('D365FO_UI_BROWSER_CHANNEL', channel);
}
function browserFixture() {
  const page = { on: vi.fn(), isClosed: () => false, goto: vi.fn(), context: () => context };
  const cdp = { on: vi.fn(), send: vi.fn(), detach: vi.fn(async () => {}) };
  const context = {
    newPage: async () => page,
    on: vi.fn(),
    route: vi.fn(),
    newCDPSession: async () => cdp,
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  };
  const browser = { close: vi.fn(async () => {}), newContext: async () => context };
  return { browser, page };
}

it('falls back to installed Edge on Chromium launch failure and exposes its choice', async () => {
  configure();
  const { browser } = browserFixture();
  vi.mocked(chromium.launch)
    .mockRejectedValueOnce(new Error('Executable does not exist at C:/private/browser.exe'))
    .mockResolvedValueOnce(browser as any);
  const opened = await GuidedBrowser.open(undefined);
  try {
    expect(chromium.launch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(chromium.launch).mock.calls[1][0]?.channel).toBe('msedge');
    expect((opened as any).browserChannel).toBe('msedge');
    expect((opened as any).browserFallback).toContain('Chromium');
    expect((opened as any).browserFallback).not.toContain('private');
  } finally {
    await opened.close();
  }
});

it.each(['chromium', 'msedge'])('honors explicit %s without fallback', async channel => {
  configure(channel);
  vi.mocked(chromium.launch).mockRejectedValue(new Error('missing browser'));
  await expect(GuidedBrowser.open(undefined)).rejects.toMatchObject({
    diagnostic: { phase: 'launch', browserChannel: channel },
  });
  expect(chromium.launch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(chromium.launch).mock.calls[0][0]?.channel).toBe(channel === 'chromium' ? undefined : 'msedge');
});

it('never falls back after navigation fails and strips raw browser failure details', async () => {
  configure();
  const { browser, page } = browserFixture();
  page.goto.mockRejectedValue(
    new Error('page.goto: net::ERR_NAME_NOT_RESOLVED https://test.example/private?password=secret'),
  );
  vi.mocked(chromium.launch).mockResolvedValue(browser as any);
  const error = await GuidedBrowser.open(undefined).catch(error => error);
  expect(chromium.launch).toHaveBeenCalledTimes(1);
  expect(error.diagnostic).toEqual({ phase: 'navigation', code: 'ERR_NAME_NOT_RESOLVED' });
  expect(error.message).not.toMatch(/private|password|secret/);
  expect(browser.close).toHaveBeenCalled();
});

it('closes a browser that resolves after cancellation without launching a fallback', async () => {
  configure();
  const { browser } = browserFixture();
  const controller = new AbortController();
  vi.mocked(chromium.launch).mockImplementation(async () => {
    controller.abort();
    return browser as any;
  });
  await expect(GuidedBrowser.open(undefined, undefined, { signal: controller.signal })).rejects.toMatchObject({
    code: 'NOT_VERIFIED',
  });
  expect(browser.close).toHaveBeenCalled();
  expect(chromium.launch).toHaveBeenCalledTimes(1);
});

it('reports safe launch diagnostics for authenticate rather than a generic failure', async () => {
  configure('msedge');
  vi.mocked(chromium.launch).mockRejectedValue(
    new Error("Executable doesn't exist at C:/Users/private/browser.exe; https://login.example/?password=secret"),
  );
  const result = await authenticateUi(undefined, { companySelector: '#company', company: 'USMF' });
  expect(result).toMatchObject({
    status: 'NOT_VERIFIED',
    diagnostic: { phase: 'launch', code: 'BROWSER_NOT_INSTALLED' },
  });
  expect(JSON.stringify(result)).not.toMatch(/private|password|secret/);
});

it('exposes only the blocked origin and safe reason for rejected navigation', () => {
  let error: any;
  try {
    allowedNavigationUrl('https://user:password@blocked.example/private?token=secret', ['https://test.example']);
  } catch (caught) {
    error = caught;
  }
  expect(error.diagnostic).toEqual({
    phase: 'navigation',
    code: 'NAVIGATION_BLOCKED',
    blockedOrigin: 'https://blocked.example',
  });
  expect(error.message).not.toMatch(/user|password|private|token|secret/);
});

it('reports both launch causes when automatic fallback also fails', async () => {
  vi.mocked(chromium.launch)
    .mockRejectedValueOnce(new Error("Executable doesn't exist at C:/private"))
    .mockRejectedValueOnce(Object.assign(new Error('secret launch log'), { code: 'EACCES' }));
  await expect(launchUiBrowser()).rejects.toMatchObject({
    diagnostic: {
      phase: 'launch',
      code: 'EACCES',
      browserChannel: 'msedge',
      fallbackFromCode: 'BROWSER_NOT_INSTALLED',
    },
  });
});

it('returns cancellation promptly and closes a late launch without retrying', async () => {
  const { browser } = browserFixture();
  let resolveLaunch!: (value: any) => void;
  vi.mocked(chromium.launch).mockImplementation(
    () =>
      new Promise(resolve => {
        resolveLaunch = resolve;
      }),
  );
  const controller = new AbortController();
  const launching = launchUiBrowser({ signal: controller.signal });
  controller.abort();
  await expect(launching).rejects.toMatchObject({ diagnostic: { code: 'CANCELLED' } });
  resolveLaunch(browser);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(chromium.launch).toHaveBeenCalledTimes(1);
});

it('closes a launch resolving after its deadline without retrying', async () => {
  const { browser } = browserFixture();
  let resolveLaunch!: (value: any) => void;
  vi.mocked(chromium.launch).mockImplementation(
    () =>
      new Promise(resolve => {
        resolveLaunch = resolve;
      }),
  );
  const launching = launchUiBrowser({ deadline: Date.now() + 15 });
  await expect(launching).rejects.toMatchObject({ diagnostic: { code: 'DEADLINE_EXCEEDED' } });
  resolveLaunch(browser);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(chromium.launch).toHaveBeenCalledTimes(1);
});

it('allows exact Microsoft authentication origins without allowing lookalike domains', () => {
  for (const origin of ['https://login.microsoftonline.com', 'https://login.windows.net'])
    expect(allowedNavigationUrl(`${origin}/tenant?code=secret`, defaultAuthenticationOrigins)).toContain(origin);
  expect(() => allowedNavigationUrl('https://login.windows.net.evil.example/', defaultAuthenticationOrigins)).toThrow();
});

it('drops arbitrary error text, codes and diagnostic fields', () => {
  const raw = Object.assign(new Error('password=secret C:/private https://host/private?token=secret'), {
    code: 'SECRET_PASSWORD',
    diagnostic: {
      phase: 'launch',
      code: 'BROWSER_LAUNCH_FAILED',
      browserChannel: 'secret',
      blockedOrigin: 'https://user:password@host/private?token=secret',
      fallbackFromCode: 'secret',
    },
  });
  expect(safeUiDiagnostic(raw, 'operation')).toEqual({
    phase: 'launch',
    code: 'BROWSER_LAUNCH_FAILED',
    blockedOrigin: 'https://host',
  });
});

it('reports authentication cancellation before launch with a useful safe code', async () => {
  configure();
  const controller = new AbortController();
  controller.abort();
  const result = await authenticateUi(
    undefined,
    { companySelector: '#company', company: 'USMF' },
    { signal: controller.signal },
  );
  expect(result).toMatchObject({ status: 'NOT_VERIFIED', diagnostic: { code: 'CANCELLED' } });
  expect(chromium.launch).not.toHaveBeenCalled();
});
