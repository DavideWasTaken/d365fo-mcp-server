import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { installNavigationGuard } from '../../src/tools/sdlc/uiVerification/navigation.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVerification } from '../../src/tools/sdlc/uiVerification/runner.js';
import { examplePlan, type Plan } from '../../src/tools/sdlc/uiVerification/contract.js';
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
import { loadEnv } from '../../src/utils/loadEnv.js';
let server: Server, dir: string, baseUrl: string, profilePath: string;
let foreignHits = 0;
let writes = 0;
const nativePosts: string[] = [];
let nextHopHits = 0;
let foreign: Server, foreignUrl: string;
const html = `<span id="company">USMF</span><span id="record">UI-TEST-001</span><input id="quantity" value="1"><button id="save">Save</button><span id="result">Fresh</span><script>document.querySelector('#save').onclick=()=>{setTimeout(()=>{document.querySelector('#result').textContent=Number(document.querySelector('#quantity').value)>0?'Saved':'Quantity must be positive';localStorage.setItem('touched','yes');fetch('/mutate')},150)}; setTimeout(()=>{const x=document.createElement('div');x.id='delayed';x.textContent='Ready';document.body.appendChild(x)},100); if(localStorage.getItem('touched')) document.querySelector('#result').textContent='Leaked';</script>`;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ui-verification-'));
  foreign = createServer((_req, res) => {
    foreignHits++;
    res.end('foreign');
  });
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  foreignUrl = `http://127.0.0.1:${(foreign.address() as any).port}`;
  server = createServer((req, res) => {
    if (req.url === '/credential-redirect') {
      res.writeHead(302, { Location: baseUrl.replace('://', '://user:password@') + '/final' });
      res.end();
      return;
    }
    if (req.url === '/popup') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html + `<button id="popup" onclick="window.open('${foreignUrl}')">Popup</button>`);
      return;
    }
    if (req.url === '/native-post') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        html +
          '<form method="post" action="/posted"><input name="quantity" value="7"><button id="send">Send</button></form>',
      );
      return;
    }
    if (req.url === '/posted') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        nativePosts.push(`${req.method}:${body}`);
        res.writeHead(303, { Location: '/post-final', 'Set-Cookie': 'hop=accepted; Path=/' });
        res.end();
      });
      return;
    }
    if (req.url === '/post-final') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        html.replace(
          '>Fresh<',
          req.method === 'GET' && req.headers.cookie?.includes('hop=accepted') ? '>Posted<' : '>Bad transport<',
        ),
      );
      return;
    }
    if (req.url === '/hidden-duplicates') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<section hidden><input id="quantity"><span id="company">OTHER</span><span id="result">Other</span></section>' +
          html,
      );
      return;
    }
    if (req.url?.startsWith('/loop/')) {
      const hop = Number(req.url.split('/').at(-1));
      res.writeHead(302, { Location: `/loop/${hop + 1}` });
      res.end();
      return;
    }
    if (req.url === '/slow-navigation') {
      setTimeout(() => {
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
      }, 700);
      return;
    }
    if (req.url === '/chain-start' || req.url === '/same-redirect') {
      res.writeHead(302, { Location: req.url === '/chain-start' ? '/chain-middle' : '/final' });
      res.end();
      return;
    }
    if (req.url === '/chain-middle') {
      nextHopHits++;
      res.writeHead(302, { Location: foreignUrl });
      res.end();
      return;
    }
    if (req.url === '/final') nextHopHits++;
    if (req.url === '/delayed-company') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        html.replace('id="company">USMF', 'id="company">Loading') +
          '<script>setTimeout(()=>document.querySelector("#company").textContent="USMF",150)</script>',
      );
      return;
    }
    if (req.url === '/scoped') {
      res.setHeader('Content-Type', 'text/html');
      const form =
        '<span id="record">UI-TEST-001</span><input id="quantity" value="1"><span id="result">Fresh result</span><span class="hidden" hidden>A</span><span class="hidden" hidden>B</span>';
      res.end(
        '<span id="company">USMF</span><section hidden>' +
          form +
          '</section><section id="active">' +
          form +
          '</section><section>' +
          form +
          '</section>',
      );
      return;
    }
    if (req.url === '/mutate') {
      writes++;
      res.end('ok');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: foreignUrl });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(req.headers.cookie?.includes('auth=yes') ? html : '<h1>Login required</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  await writeFile(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      cookies: [
        {
          name: 'auth',
          value: 'yes',
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
  profilePath = path.join(dir, 'profile.json');
  await writeFile(
    profilePath,
    JSON.stringify({ baseUrl, storageState: 'auth.json', outputDir: 'reports', headless: true }),
  );
});
afterAll(async () => {
  await Promise.all([
    new Promise<void>(r => server.close(() => r())),
    new Promise<void>(r => foreign.close(() => r())),
  ]);
  await rm(dir, { recursive: true, force: true });
});
const plan = (): Plan => structuredClone(examplePlan);
const options = { stepTimeoutMs: 1000, caseTimeoutMs: 5000 };
describe('real browser UI verification fixture', () => {
  it('classifies a text assertion on an input as unavailable rather than functional failure', async () => {
    const p = plan();
    p.cases = p.cases.slice(0, 1);
    p.cases[0].steps = [{ action: 'assert', selector: '#quantity', check: 'text', expected: '1', match: 'exact' }];
    const result = await runVerification(profilePath, p, options);
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.cases[0].reason).toContain('value');
    p.cases[0].steps = [{ action: 'assert', selector: '#quantity', check: 'value', expected: '1' }];
    expect((await runVerification(profilePath, p, options)).status).toBe('PASS');
  });
  it('waits for a missing URL and resumes the test with the user answer without restarting', async () => {
    vi.stubEnv('D365FO_UI_TEST_URL', '');
    vi.stubEnv('D365FO_UI_STORAGE_STATE', path.join(dir, 'auth.json'));
    vi.stubEnv('D365FO_UI_OUTPUT_DIR', path.join(dir, 'answered-reports'));
    try {
      const beforeWrites = writes;
      const pending = await verifyUiCustomizationTool({ action: 'run', plan: plan() }, options);
      expect(JSON.parse(pending.content[0].text).requiresUserInput).toBe(true);
      expect(writes).toBe(beforeWrites);
      const resumed = await verifyUiCustomizationTool(
        { action: 'run', environmentUrl: baseUrl, plan: plan() },
        options,
      );
      const report = JSON.parse(resumed.content[0].text);
      expect(report.status, resumed.content[0].text).toBe('PASS');
      expect(report.cases.map((c: any) => c.status)).toEqual(['PASS', 'PASS']);
      expect(report.reportPath).toContain(path.join(dir, 'answered-reports'));
      expect(process.env.D365FO_UI_TEST_URL).toBe('');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('loads setup configuration and executes both cases without a profile file', async () => {
    const configPath = path.join(dir, 'd365fo-mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({
        environment: { uiTestUrl: baseUrl, uiStorageState: 'auth.json', uiOutputDir: 'configured-reports' },
      }),
    );
    const originalEnv = { ...process.env };
    try {
      delete process.env.D365FO_UI_TEST_URL;
      delete process.env.D365FO_UI_STORAGE_STATE;
      delete process.env.D365FO_UI_OUTPUT_DIR;
      process.env.D365FO_CONFIG = configPath;
      loadEnv(import.meta.url);
      const result = await verifyUiCustomizationTool({ action: 'run', plan: plan() }, options);
      const report = JSON.parse(result.content[0].text);
      expect(report.status, result.content[0].text).toBe('PASS');
      expect(report.cases.map((c: any) => c.status)).toEqual(['PASS', 'PASS']);
      expect(report.reportPath).toContain(path.join(dir, 'configured-reports'));
      expect(await readFile(report.reportPath, 'utf8')).toContain('Quantity must be positive');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });
  it('keeps explicit profiles authoritative over another configured environment', async () => {
    vi.stubEnv('D365FO_UI_TEST_URL', foreignUrl);
    vi.stubEnv('D365FO_UI_STORAGE_STATE', path.join(dir, 'nonexistent-auth.json'));
    try {
      const result = await runVerification(profilePath, plan(), options);
      expect(result.status).toBe('PASS');
      expect(result.environment).toBe(baseUrl);
      expect(foreignHits).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('verifies positive and negative business outcomes with isolated auth contexts', async () => {
    const p = plan();
    p.cases.forEach(c => c.preconditions.push({ selector: '#result', check: 'text', expected: 'Fresh' }));
    const r = await runVerification(profilePath, p, options);
    expect(r.status, JSON.stringify(r.cases)).toBe('PASS');
    expect(r.cases.map(c => c.status)).toEqual(['PASS', 'PASS']);
    expect(await readFile(r.reportPath, 'utf8')).toContain('Quantity must be positive');
  });
  it('separates functional mismatch from ambiguous or missing locator and stops the case', async () => {
    const p = plan();
    p.cases[0].steps = [
      { action: 'assert', selector: '#quantity', check: 'value', expected: 'wrong' },
      { action: 'click', selector: '#save' },
    ];
    p.cases[1].steps = [
      { action: 'click', selector: 'span' },
      { action: 'assert', selector: '#result', check: 'text', expected: 'Saved' },
    ];
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('FAIL');
    expect(r.cases.map(c => c.status)).toEqual(['FAIL', 'NOT_VERIFIED']);
    expect(r.cases[0].steps.at(-1)?.label).toContain('assert');
    expect(r.cases[0].screenshot).toBeTruthy();
  });
  it('refuses foreign URLs and redirects without reaching the foreign server', async () => {
    const p = plan();
    p.startUrl = '/redirect';
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('NOT_VERIFIED');
    expect(foreignHits).toBe(0);
    p.startUrl = foreignUrl;
    expect((await runVerification(profilePath, p, options)).status).toBe('NOT_VERIFIED');
    expect(foreignHits).toBe(0);
  });
  it('does not pass wrong company, failed preconditions, or missing build readiness', async () => {
    for (const p of [
      Object.assign(plan(), { company: 'DEMF' }),
      Object.assign(plan(), { buildReference: { reference: 'pending', ready: false } }),
    ]) {
      expect((await runVerification(profilePath, p, options)).status).toBe('NOT_VERIFIED');
    }
    const p = plan();
    p.cases[0].preconditions[0].expected = 'other record';
    const r = await runVerification(profilePath, p, options);
    expect(r.cases.map(c => c.status)).toEqual(['NOT_VERIFIED', 'PASS']);
  });
  it('cancels owned contexts and skips all remaining interactions', async () => {
    const p = plan();
    p.cases[0].steps.unshift({ action: 'wait', selector: '#never' });
    const beforeWrites = writes;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const r = await runVerification(profilePath, p, { ...options, signal: controller.signal });
    clearTimeout(timer);
    expect(r.status).toBe('NOT_VERIFIED');
    expect(r.cases[1].steps).toHaveLength(0);
    await new Promise(r => setTimeout(r, 550));
    expect(writes).toBe(beforeWrites);
  });
  it('waits for a delayed DOM element before an action', async () => {
    const p = plan();
    p.cases.forEach(c => c.steps.unshift({ action: 'wait', selector: '#delayed' }));
    expect((await runVerification(profilePath, p, options)).status).toBe('PASS');
  });
  it('bounds the whole case even when individual steps have time remaining', async () => {
    const p = plan();
    p.cases.forEach(c => c.steps.unshift({ action: 'wait', selector: '#never' }));
    const r = await runVerification(profilePath, p, { stepTimeoutMs: 1000, caseTimeoutMs: 200 });
    expect(r.status).toBe('NOT_VERIFIED');
    expect(
      r.cases.every(c => c.reason?.includes('120') || c.reason?.includes('deadline')),
      JSON.stringify(r.cases),
    ).toBe(true);
  });
  it('reports a missing saved session and same-origin login page as NOT_VERIFIED', async () => {
    const missingProfile = path.join(dir, 'missing-profile.json');
    await writeFile(missingProfile, JSON.stringify({ baseUrl, storageState: 'absent.json', outputDir: 'reports' }));
    expect((await runVerification(missingProfile, plan(), options)).status).toBe('NOT_VERIFIED');
    await writeFile(
      path.join(dir, 'expired.json'),
      JSON.stringify({
        cookies: [],
        origins: [{ origin: baseUrl, localStorage: [{ name: 'expired', value: 'yes' }] }],
      }),
    );
    await writeFile(missingProfile, JSON.stringify({ baseUrl, storageState: 'expired.json', outputDir: 'reports' }));
    const r = await runVerification(missingProfile, plan(), options);
    expect(r.cases.map(c => c.status)).toEqual(['NOT_VERIFIED', 'NOT_VERIFIED']);
  });
  it('follows same-origin redirects using browser cookies', async () => {
    const p = plan();
    p.startUrl = '/same-redirect';
    const r = await runVerification(profilePath, p, options);
    expect(r.status, JSON.stringify(r.cases)).toBe('PASS');
    expect(nextHopHits).toBeGreaterThan(0);
  });
  it('blocks a foreign second redirect hop before the foreign server is reached', async () => {
    const before = nextHopHits;
    const p = plan();
    p.startUrl = '/chain-start';
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('NOT_VERIFIED');
    expect(nextHopHits).toBeGreaterThan(before);
    expect(foreignHits).toBe(0);
    expect(r.cases[0].reason).toContain('origin');
  });
  it('saves the validated reusable plan and reports every supplied case', async () => {
    for (const count of [1, 3, 5]) {
      const p = plan();
      p.cases = Array.from({ length: count }, (_, i) => ({ ...structuredClone(p.cases[0]), name: `Case ${i}` }));
      const r = await runVerification(profilePath, p, options);
      expect(r.status).toBe('PASS');
      expect(r.cases).toHaveLength(count);
      expect(JSON.parse(await readFile(r.planPath, 'utf8'))).toEqual(p);
    }
  });
  it('supports contains and visible form scoping while ignoring hidden duplicates', async () => {
    const p = plan();
    p.startUrl = '/scoped';
    p.cases.forEach(c => {
      c.scope = '#active';
      c.preconditions = [{ selector: '#record', check: 'text', expected: 'UI-TEST-001' }];
      c.steps = [
        { action: 'fill', selector: '#quantity', value: '2' },
        { action: 'assert', selector: '#quantity', check: 'value', expected: '2' },
        { action: 'assert', selector: '#result', check: 'text', match: 'contains', expected: 'Fresh' },
        { action: 'assert', selector: '.hidden', check: 'visible', expected: false },
        { action: 'assert', selector: '#absent', check: 'visible', expected: false },
      ];
    });
    expect((await runVerification(profilePath, p, options)).status).toBe('PASS');
    p.cases.forEach(c => {
      delete c.scope;
    });
    expect((await runVerification(profilePath, p, options)).status).toBe('NOT_VERIFIED');
  });
  it('does not retry a write when its following assertion fails', async () => {
    const before = writes;
    const p = plan();
    p.cases.forEach(c => {
      c.steps = [
        { action: 'click', selector: '#save' },
        { action: 'assert', selector: '#result', check: 'text', expected: 'Impossible' },
        { action: 'click', selector: '#save' },
      ];
    });
    const r = await runVerification(profilePath, p, options);
    expect(r.cases.map(c => c.status)).toEqual(['FAIL', 'FAIL']);
    expect(writes - before).toBe(2);
  });
  it('rejects embedded credentials on a same-origin redirect hop', async () => {
    const before = nextHopHits;
    const p = plan();
    p.startUrl = '/credential-redirect';
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('NOT_VERIFIED');
    expect(nextHopHits).toBe(before);
  });
  it('blocks unexpected popups before their first foreign navigation request', async () => {
    const before = foreignHits;
    const p = plan();
    p.startUrl = '/popup';
    p.cases.forEach(c => {
      c.steps = [
        { action: 'click', selector: '#popup' },
        { action: 'assert', selector: '#result', check: 'text', expected: 'Fresh' },
      ];
    });
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('NOT_VERIFIED');
    expect(foreignHits).toBe(before);
  });
  it('preserves native POST redirect methods and response cookies without replay', async () => {
    const before = nativePosts.length;
    const p = plan();
    p.startUrl = '/native-post';
    p.cases.forEach(c => {
      c.steps = [
        { action: 'click', selector: '#send' },
        { action: 'assert', selector: '#result', check: 'text', expected: 'Posted' },
      ];
    });
    const r = await runVerification(profilePath, p, options);
    expect(r.status, JSON.stringify(r.cases)).toBe('PASS');
    expect(nativePosts.slice(before)).toEqual(['POST:quantity=7', 'POST:quantity=7']);
  });
  it('uses visible controls and company when hidden duplicates remain in the DOM', async () => {
    const p = plan();
    p.startUrl = '/hidden-duplicates';
    // Avoid the fixture's intentionally broad querySelector save handler, which targets its first input.
    p.cases.forEach(c => {
      c.steps = [
        { action: 'fill', selector: '#quantity', value: '9' },
        { action: 'assert', selector: '#quantity', check: 'value', expected: '9' },
      ];
    });
    const r = await runVerification(profilePath, p, options);
    expect(r.status, JSON.stringify(r.cases)).toBe('PASS');
  });
  it('bounds redirect loops and reports why they were blocked', async () => {
    const p = plan();
    p.startUrl = '/loop/0';
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('NOT_VERIFIED');
    expect(r.cases[0].reason).toContain('maximum 10 redirects');
  });
  it('uses a separate navigation budget and merges bounded profile/run timeouts', async () => {
    const timeoutProfile = path.join(dir, 'timeouts-profile.json');
    await writeFile(
      timeoutProfile,
      JSON.stringify({
        baseUrl,
        storageState: 'auth.json',
        outputDir: 'reports',
        timeouts: { stepTimeoutMs: 45000, navigationTimeoutMs: 90000, caseTimeoutMs: 240000 },
      }),
    );
    const p = plan();
    p.startUrl = '/slow-navigation';
    p.cases.forEach(c => {
      c.steps = [{ action: 'assert', selector: '#quantity', check: 'value', expected: '1' }];
    });
    const r = await runVerification(timeoutProfile, p, {
      stepTimeoutMs: 500,
      navigationTimeoutMs: 1500,
      caseTimeoutMs: 5000,
      timeouts: { stepTimeoutMs: 60000 },
    });
    expect(r.status, JSON.stringify(r.cases)).toBe('PASS');
    expect(r.timeouts).toEqual({ stepTimeoutMs: 500, navigationTimeoutMs: 1500, caseTimeoutMs: 5000 });
    p.startUrl = '/';
    const configured = await runVerification(timeoutProfile, p, { timeouts: { stepTimeoutMs: 60000 } });
    expect(configured.timeouts).toEqual({ stepTimeoutMs: 60000, navigationTimeoutMs: 90000, caseTimeoutMs: 240000 });
  });
  it('waits for the initial company placeholder to settle before checking preconditions', async () => {
    const p = plan();
    p.startUrl = '/delayed-company';
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('PASS');
  });
});

describe('child guard lifecycle', () => {
  it('ignores ordinary child detach while initialization is pending but blocks live transport failures', async () => {
    for (const detached of [true, false]) {
      const session = new EventEmitter() as EventEmitter & {
        send: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
      };
      let commandId: number | undefined;
      session.send = vi.fn(async (method: string, params: any) => {
        if (method === 'Target.sendMessageToTarget') commandId = JSON.parse(params.message).id;
        return {};
      });
      session.detach = vi.fn(async () => {});
      const page = {
        isClosed: () => false,
        context: () => ({ newCDPSession: async () => session }),
      } as unknown as Page;
      const blocked: string[] = [];
      const cleanup = await installNavigationGuard(page, ['https://example.com'], reason => blocked.push(reason));
      session.emit('Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
      if (detached) session.emit('Target.detachedFromTarget', { sessionId: 'child' });
      else
        session.emit('Target.receivedMessageFromTarget', {
          sessionId: 'child',
          message: JSON.stringify({ id: commandId, error: { message: 'Fetch interception unavailable' } }),
        });
      await new Promise(resolve => setImmediate(resolve));
      if (detached) expect(blocked).toEqual([]);
      else {
        expect(blocked).toHaveLength(1);
        expect(blocked[0]).toContain('NAVIGATION_GUARD_FAILED');
        expect(blocked[0]).toContain('navigation guard could not initialize or communicate with a frame');
      }
      await cleanup();
    }
  });
});
