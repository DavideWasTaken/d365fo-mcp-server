import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVerification } from '../../src/tools/sdlc/uiVerification/runner.js';
import { examplePlan, type Plan } from '../../src/tools/sdlc/uiVerification/contract.js';
let server: Server, dir: string, baseUrl: string, profilePath: string;
let foreignHits = 0;
let writes = 0;
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
  it('rejects all navigation redirects before any subsequent hop can escape the origin', async () => {
    for (const startUrl of ['/chain-start', '/same-redirect']) {
      const p = plan();
      p.startUrl = startUrl;
      const r = await runVerification(profilePath, p, options);
      expect(r.status).toBe('NOT_VERIFIED');
      expect(nextHopHits).toBe(0);
      expect(foreignHits).toBe(0);
      expect(r.cases[0].reason).toContain('Use the final application URL');
    }
  });
  it('waits for the initial company placeholder to settle before checking preconditions', async () => {
    const p = plan();
    p.startUrl = '/delayed-company';
    const r = await runVerification(profilePath, p, options);
    expect(r.status).toBe('PASS');
  });
});
