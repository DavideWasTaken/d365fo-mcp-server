import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { authenticateUi } from '../../src/tools/sdlc/uiVerification/authenticate.js';
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
import { installNavigationGuard } from '../../src/tools/sdlc/uiVerification/navigation.js';

let environment: Server, identity: Server, foreign: Server;
let baseUrl: string, identityUrl: string, foreignUrl: string, dir: string;
let identityHits = 0,
  foreignHits = 0;
let identityFrameHits = 0;
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ui-authentication-'));
  foreign = createServer((_req, res) => {
    foreignHits++;
    res.end('foreign');
  });
  foreignUrl = await listen(foreign);
  identity = createServer((req, res) => {
    identityHits++;
    if (req.url === '/stable-frame') {
      res.end('<h1>Identity frame</h1>');
      return;
    }
    if (req.url === '/frame') {
      identityFrameHits++;
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Identity frame</h1><script>setTimeout(()=>location.href="/foreign",300)</script>');
      return;
    }
    res.writeHead(302, { Location: req.url === '/foreign' ? foreignUrl : `${baseUrl}/return` });
    res.end();
  });
  identityUrl = await listen(identity);
  environment = createServer((req, res) => {
    if (req.url === '/stable-identity-frame') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<iframe src="${identityUrl.replace('127.0.0.1', 'localhost')}/stable-frame"></iframe>`);
      return;
    }
    if (req.url === '/identity-frame') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<h1>Complete login</h1><iframe src="${identityUrl.replace('127.0.0.1', 'localhost')}/frame"></iframe>`);
      return;
    }
    if (req.url === '/login' && !req.headers.cookie?.includes('fixture-auth=yes')) {
      res.writeHead(302, { Location: `${identityUrl}/login` });
      res.end();
      return;
    }
    if (req.url === '/foreign') {
      res.writeHead(302, { Location: `${identityUrl}/foreign` });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/pending') {
      res.end('<h1>Complete login</h1>');
      return;
    }
    if (req.url === '/wrong-company') {
      res.end('<span id="company">DEMF</span>');
      return;
    }
    if (req.url === '/duplicate') {
      res.end('<span id="company">USMF</span><span id="company">USMF</span>');
      return;
    }
    if (req.url === '/popup') {
      res.end(`<script>window.open('${foreignUrl}')</script>`);
      return;
    }
    if (req.url === '/return') res.setHeader('Set-Cookie', 'fixture-auth=yes; Path=/; HttpOnly; SameSite=Lax');
    res.end(`<script>
      localStorage.setItem('fixture-user', 'signed-in');
      const request = indexedDB.open('fixture-session', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('tokens');
      request.onsuccess = () => {
        const transaction = request.result.transaction('tokens', 'readwrite');
        transaction.objectStore('tokens').put('fixture-token', 'session');
        transaction.oncomplete = () => {
          request.result.close();
          document.body.innerHTML = '<span id="company" hidden>OLD</span><span id="company">USMF</span>';
        };
      };
    </script>`);
  });
  baseUrl = await listen(environment);
});
afterAll(async () => {
  await Promise.all(
    [environment, identity, foreign].map(server => new Promise<void>(resolve => server.close(() => resolve()))),
  );
  await rm(dir, { recursive: true, force: true });
});
async function profile(name: string, route: string, oldState?: string) {
  const profilePath = path.join(dir, `${name}.json`);
  const storageStatePath = path.join(dir, `${name}-auth.json`);
  if (oldState) await writeFile(storageStatePath, oldState);
  await writeFile(
    profilePath,
    JSON.stringify({
      baseUrl: baseUrl + route,
      authenticationOrigins: [identityUrl, identityUrl.replace('127.0.0.1', 'localhost')],
      storageState: path.basename(storageStatePath),
      outputDir: 'reports',
      headless: true,
    }),
  );
  return { profilePath, storageStatePath };
}
const input = { company: 'USMF', companySelector: '#company' };
const options = { headless: true, timeoutMs: 6000 };
const oldState = JSON.stringify({
  cookies: [],
  origins: [{ origin: 'https://previous.example', localStorage: [{ name: 'keep', value: 'unchanged' }] }],
});

describe('owned browser authentication', () => {
  it('asks for the environment URL when authentication has no configured environment', async () => {
    vi.stubEnv('D365FO_UI_TEST_URL', '');
    try {
      const response = await verifyUiCustomizationTool({ action: 'authenticate', ...input });
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        status: 'NOT_VERIFIED',
        requiresUserInput: true,
        missingField: 'environmentUrl',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('follows the configured identity provider and saves cookie, localStorage and IndexedDB state that can be loaded again', async () => {
    const { profilePath, storageStatePath } = await profile('success', '/login');
    const beforeIdentity = identityHits;
    const result = await authenticateUi(profilePath, input, options);
    expect(result, JSON.stringify(result)).toEqual({ status: 'AUTHENTICATED', storageStatePath });
    expect(identityHits).toBeGreaterThan(beforeIdentity);
    const state = JSON.parse(await readFile(storageStatePath, 'utf8'));
    expect(state.cookies.some((cookie: any) => cookie.name === 'fixture-auth')).toBe(true);
    const origin = state.origins.find((entry: any) => entry.origin === baseUrl);
    expect(origin.localStorage).toContainEqual({ name: 'fixture-user', value: 'signed-in' });
    expect(origin.indexedDB[0].stores[0].records).toContainEqual({ key: 'session', value: 'fixture-token' });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: storageStatePath });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/pending`);
      expect(await page.evaluate(() => localStorage.getItem('fixture-user'))).toBe('signed-in');
      expect(
        await page.evaluate(
          () =>
            new Promise(resolve => {
              const open = indexedDB.open('fixture-session');
              open.onsuccess = () => {
                const read = open.result.transaction('tokens').objectStore('tokens').get('session');
                read.onsuccess = () => {
                  resolve(read.result);
                  open.result.close();
                };
              };
            }),
        ),
      ).toBe('fixture-token');
    } finally {
      await browser.close();
    }
    const savedIdentityHits = identityHits;
    expect((await authenticateUi(profilePath, input, options)).status).toBe('AUTHENTICATED');
    expect(identityHits).toBe(savedIdentityHits);
  }, 20000);
  it('blocks a foreign redirect before its server is reached and preserves existing state', async () => {
    const { profilePath, storageStatePath } = await profile('foreign', '/foreign', oldState);
    const beforeForeign = foreignHits;
    const result = await authenticateUi(profilePath, input, options);
    expect(result.status).toBe('NOT_VERIFIED');
    expect(foreignHits).toBe(beforeForeign);
    expect(await readFile(storageStatePath, 'utf8')).toBe(oldState);
  });
  it('blocks foreign redirect hops from a live cross-site identity iframe before their server is reached', async () => {
    const { profilePath, storageStatePath } = await profile('identity-frame', '/identity-frame', oldState);
    const beforeForeign = foreignHits;
    const beforeFrame = identityFrameHits;
    const result = await authenticateUi(profilePath, input, { ...options, timeoutMs: 2000 });
    expect(identityFrameHits).toBeGreaterThan(beforeFrame);
    expect(result.status).toBe('NOT_VERIFIED');
    expect(foreignHits).toBe(beforeForeign);
    expect(await readFile(storageStatePath, 'utf8')).toBe(oldState);
  });
  it('protects an independently confirmed out-of-process iframe navigation', async () => {
    const browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const blocked: string[] = [];
      const crossSiteIdentity = identityUrl.replace('127.0.0.1', 'localhost');
      cleanup = await installNavigationGuard(page, [baseUrl, crossSiteIdentity], reason => blocked.push(reason));
      await page.goto(`${baseUrl}/stable-identity-frame`);
      const session = await browser.newBrowserCDPSession();
      const { targetInfos } = await session.send('Target.getTargets');
      expect(targetInfos.some(target => target.type === 'iframe' && target.url.startsWith(crossSiteIdentity))).toBe(
        true,
      );
      const frame = page.frames().find(frame => frame.url().startsWith(crossSiteIdentity))!;
      const beforeForeign = foreignHits;
      await frame.goto(`${crossSiteIdentity}/foreign`, { timeout: 2000 }).catch(() => {});
      expect(foreignHits).toBe(beforeForeign);
      expect(blocked).toHaveLength(1);
    } finally {
      await browser.close();
      await cleanup?.();
    }
  });
  it('times out without modifying existing state or leaving temporary state files', async () => {
    const { profilePath, storageStatePath } = await profile('timeout', '/pending', oldState);
    const result = await authenticateUi(profilePath, input, { ...options, timeoutMs: 1200 });
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.reason).toMatch(/deadline|timed out|timeout/i);
    expect(await readFile(storageStatePath, 'utf8')).toBe(oldState);
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('cancels a waiting login and preserves existing state', async () => {
    const { profilePath, storageStatePath } = await profile('cancel', '/pending', oldState);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const result = await authenticateUi(profilePath, input, { ...options, signal: controller.signal });
      expect(result.status).toBe('NOT_VERIFIED');
      expect(result.reason).toMatch(/cancel/i);
      expect(await readFile(storageStatePath, 'utf8')).toBe(oldState);
    } finally {
      clearTimeout(timer);
    }
  });
  it('does not save state for a wrong company or ambiguous visible company selector', async () => {
    for (const route of ['/wrong-company', '/duplicate']) {
      const { profilePath, storageStatePath } = await profile(route.slice(1), route, oldState);
      expect((await authenticateUi(profilePath, input, { ...options, timeoutMs: 1200 })).status).toBe('NOT_VERIFIED');
      expect(await readFile(storageStatePath, 'utf8')).toBe(oldState);
    }
  });
  it('stops on unexpected popups without saving state', async () => {
    const { profilePath, storageStatePath } = await profile('popup', '/popup', oldState);
    const beforeForeign = foreignHits;
    const result = await authenticateUi(profilePath, input, options);
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.reason).toMatch(/popup/i);
    expect(foreignHits).toBe(beforeForeign);
    expect(await readFile(storageStatePath, 'utf8')).toBe(oldState);
  });
});
