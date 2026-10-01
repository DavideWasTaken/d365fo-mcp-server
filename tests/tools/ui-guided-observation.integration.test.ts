import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let server: Server, identity: Server, foreign: Server;
let dir: string, baseUrl: string, identityUrl: string, foreignUrl: string;
let foreignHits = 0;
let identityHits = 0;
const app = `<button aria-label="Company">USMF</button><button id="save">Save</button><button hidden>Save</button>
<label>Quantity<input id="quantity" value="1"></label><label>Password<input type="password" value="do-not-disclose-914"></label>
<section aria-label="Active order" role="region"><h2>Order A</h2><div role="row" data-row-key="A"><span>Order A</span><button id="row">Edit</button></div></section>
<div role="dialog" aria-label="Details"><button>Close</button></div>`;
async function listen(s: Server): Promise<string> {
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as any).port}`;
}
async function profile(route = '/'): Promise<string> {
  const file = path.join(dir, `${route.replace(/[^a-z]/g, '') || 'main'}.json`);
  await writeFile(
    file,
    JSON.stringify({
      baseUrl: baseUrl + route,
      storageState: 'auth.json',
      outputDir: 'reports',
      authenticationOrigins: [identityUrl],
    }),
  );
  return file;
}
async function open(route = '/') {
  const { GuidedBrowser } = await import('../../src/tools/sdlc/uiVerification/guided/browserSession.js');
  return GuidedBrowser.open(await profile(route), undefined, { headless: true });
}
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'guided-observation-'));
  await writeFile(path.join(dir, 'auth.json'), JSON.stringify({ cookies: [], origins: [] }));
  foreign = createServer((_req, res) => {
    foreignHits++;
    res.end('foreign');
  });
  foreignUrl = await listen(foreign);
  identity = createServer((_req, res) => {
    identityHits++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>Private identity page</h1><input type="password" value="identity-secret">');
  });
  identityUrl = await listen(identity);
  server = createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(302, { Location: identityUrl });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/long') res.end('<div role="alert">' + 'Important message '.repeat(100) + '</div>');
    else if (req.url === '/large')
      res.end(app + Array.from({ length: 180 }, (_, i) => `<button>Action ${i}</button>`).join(''));
    else if (req.url === '/frame-content') res.end('<button id="inside">Frame action</button>');
    else if (req.url === '/frame') res.end(app + '<iframe src="/frame-content"></iframe>');
    else if (req.url === '/frame-login') res.end(app + `<iframe src="${identityUrl}"></iframe>`);
    else res.end(app + `<button id="popup" onclick="window.open('${foreignUrl}')">Popup</button>`);
  });
  baseUrl = await listen(server);
});
afterAll(async () => {
  await Promise.all([server, identity, foreign].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  await rm(dir, { recursive: true, force: true });
});
describe('guided browser observed targets', () => {
  it('publishes native field values with a value check hint, never as misleading text', async () => {
    const browser = await open();
    try {
      const snapshot = await browser.observe();
      const quantity = snapshot.nodes.find(n => n.name === 'Quantity')!;
      expect(quantity.value).toBe('1');
      expect(quantity.recommendedCheck).toBe('value');
      expect(quantity.text).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
  it('distinguishes select values, textarea contents, empty inputs and checkbox checks', async () => {
    const browser = await open();
    try {
      await browser.page.setContent(
        '<label>Choice<select><option value="A">Visible label</option></select></label><label>Notes<textarea>Edited notes</textarea></label><label>Empty<input value=""></label><label>Flag<input type="checkbox"></label>',
      );
      const snapshot = await browser.observe();
      for (const [name, value, hint] of [
        ['Choice', 'A', 'value'],
        ['Notes', 'Edited notes', 'value'],
        ['Empty', '', 'value'],
        ['Flag', 'on', 'checked'],
      ]) {
        const node = snapshot.nodes.find(n => n.name === name)!;
        expect(node.value).toBe(value);
        expect(node.recommendedCheck).toBe(hint);
        expect(node.text).toBeUndefined();
      }
    } finally {
      await browser.close();
    }
  });
  it('supports public AI JSON snapshots and reference lookup with installed Chromium', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl);
      const tree = await page.ariaSnapshotJSON({ mode: 'ai' });
      const visit = (nodes: any[]): any[] => nodes.flatMap(n => [n, ...visit(n.children ?? [])]);
      const save = visit(tree as any[]).find(n => n.role === 'button' && n.name === 'Save');
      expect(save.ref).toBeTruthy();
      expect(await page.locator(`aria-ref=${save.ref}`).count()).toBe(1);
      expect(await page.locator(`aria-ref=${save.ref}`).getAttribute('id')).toBe('save');
    } finally {
      await browser.close();
    }
  });
  it('resolves observed targets, invalidates fresh snapshots, and rejects replaced nodes or recycled rows', async () => {
    const browser = await open();
    try {
      await browser.prepareCase('one');
      let snapshot = await browser.observe();
      const save = snapshot.nodes.find(n => n.name === 'Save')!;
      expect(await (await browser.resolve(snapshot.snapshotId, save.ref)).getAttribute('id')).toBe('save');
      await browser.page.locator('#save').evaluate(el => {
        el.outerHTML = '<button id="save">Save</button>';
      });
      await expect(browser.resolve(snapshot.snapshotId, save.ref)).rejects.toMatchObject({ code: 'NEEDS_OBSERVATION' });
      snapshot = await browser.observe();
      const row = snapshot.nodes.find(n => n.name === 'Edit')!;
      await browser.page.locator('[role=row]').evaluate(el => {
        el.setAttribute('data-row-key', 'B');
        el.querySelector('span')!.textContent = 'Order B';
      });
      await expect(browser.resolve(snapshot.snapshotId, row.ref)).rejects.toMatchObject({ code: 'NEEDS_OBSERVATION' });
      snapshot = await browser.observe();
      const previous = snapshot;
      await browser.observe();
      await expect(browser.resolve(previous.snapshotId, previous.nodes[0].ref)).rejects.toMatchObject({
        code: 'NEEDS_OBSERVATION',
      });
    } finally {
      await browser.close();
    }
  });
  it('redacts password data, limits nodes, and scopes only through an observed reference', async () => {
    const browser = await open('/large');
    try {
      const passwordBox = (await browser.page.locator('input[type=password]').boundingBox())!;
      const snapshot = await browser.observe({ screenshot: true });
      expect(JSON.stringify(snapshot.nodes)).not.toContain('do-not-disclose');
      expect(snapshot.nodes.length).toBeLessThanOrEqual(120);
      expect(JSON.stringify(snapshot.nodes).length).toBeLessThanOrEqual(8000);
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.image?.mimeType).toBe('image/jpeg');
      expect(Buffer.from(snapshot.image!.data, 'base64').length).toBeLessThanOrEqual(1024 * 1024);
      const rgb = await browser.page.evaluate(
        async ({ data, x, y }) => {
          const img = new Image();
          img.src = 'data:image/jpeg;base64,' + data;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          return Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
        },
        {
          data: snapshot.image!.data,
          x: Math.round(passwordBox.x + passwordBox.width / 2),
          y: Math.round(passwordBox.y + passwordBox.height / 2),
        },
      );
      expect(Math.max(...rgb)).toBeLessThan(15);
      const region = snapshot.nodes.find(n => n.name === 'Active order')!;
      const scoped = await browser.observe({ scopeRef: region.ref });
      expect(scoped.nodes.some(n => n.name === 'Edit')).toBe(true);
      expect(scoped.nodes.some(n => n.name === 'Save')).toBe(false);
      await expect(browser.observe({ scopeRef: region.ref })).rejects.toMatchObject({ code: 'NEEDS_OBSERVATION' });
    } finally {
      await browser.close();
    }
  });
  it('returns minimal AUTH_REQUIRED without observing identity pages or embedded identity frames', async () => {
    for (const route of ['/login', '/frame-login']) {
      const browser = await open(route);
      try {
        const locatorSpy = vi.spyOn(browser.page, 'locator');
        const screenshotSpy = vi.spyOn(browser.page, 'screenshot');
        const snapshot = await browser.observe({ screenshot: true });
        expect(locatorSpy).not.toHaveBeenCalled();
        expect(screenshotSpy).not.toHaveBeenCalled();
        expect(snapshot.phase).toBe('AUTH_REQUIRED');
        expect(snapshot.nodes).toEqual([]);
        expect(snapshot.image).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain('Private identity');
      } finally {
        await browser.close();
      }
    }
  });
  it('binds company exactly, preserves binding across observations, and prepares each case only once', async () => {
    const browser = await open();
    try {
      await browser.prepareCase('one');
      const firstPage = browser.page;
      let snapshot = await browser.observe();
      let company = snapshot.nodes.find(n => n.name === 'Company')!;
      await expect(browser.checkCompany()).rejects.toMatchObject({ code: 'NOT_VERIFIED' });
      await expect(browser.bindCompany(snapshot.snapshotId, company.ref, 'DEMF')).rejects.toMatchObject({
        code: 'NOT_VERIFIED',
      });
      await browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF');
      expect(JSON.parse(await readFile(path.join(dir, 'auth.json'), 'utf8')).origins).toBeDefined();
      await browser.observe();
      await browser.checkCompany();
      await browser.prepareCase('one');
      expect(browser.page).toBe(firstPage);
      await browser.checkCompany();
      await browser.prepareCase('two');
      expect(browser.page).not.toBe(firstPage);
      await expect(browser.resolve(snapshot.snapshotId, company.ref)).rejects.toMatchObject({
        code: 'NEEDS_OBSERVATION',
      });
      await expect(browser.checkCompany()).rejects.toMatchObject({ code: 'NOT_VERIFIED' });
      snapshot = await browser.observe();
      company = snapshot.nodes.find(n => n.name === 'Company')!;
      await browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF');
      await browser.page
        .getByRole('button', { name: 'Company', exact: true })
        .evaluate(el => (el.textContent = 'DEMF'));
      await expect(browser.checkCompany()).rejects.toMatchObject({ code: 'NOT_VERIFIED' });
    } finally {
      await browser.close();
    }
  });
  it('asks for a new observation, not NOT_VERIFIED, when a full page load drops the bound company', async () => {
    const browser = await open();
    try {
      await browser.prepareCase('one');
      let snapshot = await browser.observe();
      let company = snapshot.nodes.find(n => n.name === 'Company')!;
      await browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF');
      await browser.page.reload();
      // The page still shows USMF; only the bound element was replaced.
      await expect(browser.checkCompany()).rejects.toMatchObject({ code: 'NEEDS_OBSERVATION' });
      snapshot = await browser.observe();
      company = snapshot.nodes.find(n => n.name === 'Company')!;
      await browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF');
      await browser.checkCompany();
    } finally {
      await browser.close();
    }
  });
  it('resolves same-origin iframe references and rejects hidden controls and navigated documents', async () => {
    const browser = await open('/frame');
    try {
      await browser.page.frameLocator('iframe').getByRole('button', { name: 'Frame action' }).waitFor();
      let snapshot = await browser.observe();
      const frame = snapshot.nodes.find(n => n.name === 'Frame action')!;
      expect(await (await browser.resolve(snapshot.snapshotId, frame.ref)).getAttribute('id')).toBe('inside');
      const save = snapshot.nodes.find(n => n.name === 'Save')!;
      await browser.page.locator('#save').evaluate(el => {
        el.insertAdjacentHTML('afterend', '<button>Save</button>');
        (el as HTMLElement).style.display = 'none';
      });
      await expect(browser.resolve(snapshot.snapshotId, save.ref)).rejects.toMatchObject({ code: 'NEEDS_OBSERVATION' });
      snapshot = await browser.observe();
      await browser.page.goto(baseUrl);
      await expect(browser.resolve(snapshot.snapshotId, snapshot.nodes[0].ref)).rejects.toMatchObject({
        code: 'NEEDS_OBSERVATION',
      });
    } finally {
      await browser.close();
    }
  });
  it('preserves old authentication on ambiguous company and honors mission start URL', async () => {
    const old = await readFile(path.join(dir, 'auth.json'), 'utf8');
    const { GuidedBrowser } = await import('../../src/tools/sdlc/uiVerification/guided/browserSession.js');
    const browser = await GuidedBrowser.open(await profile(), undefined, { headless: true, startUrl: '/frame' });
    try {
      expect(browser.page.url()).toBe(baseUrl + '/frame');
      await browser.prepareCase('one');
      await browser.page
        .locator('body')
        .evaluate(el => el.insertAdjacentHTML('beforeend', '<button aria-label="Company">USMF</button>'));
      const snapshot = await browser.observe();
      const company = snapshot.nodes.find(n => n.name === 'Company')!;
      await expect(browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF')).rejects.toMatchObject({
        code: 'NOT_VERIFIED',
      });
      expect(await readFile(path.join(dir, 'auth.json'), 'utf8')).toBe(old);
    } finally {
      await browser.close();
    }
  });
  it('marks clipped individual messages as truncated', async () => {
    const browser = await open('/long');
    try {
      const snapshot = await browser.observe();
      expect(snapshot.nodes.some(n => n.role === 'alert')).toBe(true);
      expect(snapshot.truncated).toBe(true);
    } finally {
      await browser.close();
    }
  });
  it('rejects controls moved outside their observed scope', async () => {
    const browser = await open();
    try {
      let snapshot = await browser.observe();
      const dialog = snapshot.nodes.find(n => n.name === 'Details')!;
      snapshot = await browser.observe({ scopeRef: dialog.ref });
      const close = snapshot.nodes.find(n => n.name === 'Close')!;
      await browser.page.locator('[role=dialog] button').evaluate(el => el.ownerDocument.body.appendChild(el));
      await expect(browser.resolve(snapshot.snapshotId, close.ref)).rejects.toMatchObject({
        code: 'NEEDS_OBSERVATION',
      });
    } finally {
      await browser.close();
    }
  });
  it('allows human login discovery but blocks returning to the identity origin after company binding', async () => {
    const browser = await open('/login');
    try {
      expect((await browser.observe()).phase).toBe('AUTH_REQUIRED');
      await browser.page.goto(baseUrl);
      await browser.prepareCase('one');
      const snapshot = await browser.observe();
      const company = snapshot.nodes.find(n => n.name === 'Company')!;
      await browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF');
      const before = identityHits;
      await browser.page.goto(identityUrl).catch(() => {});
      await expect(browser.checkCompany()).rejects.toMatchObject({ code: 'NOT_VERIFIED' });
      expect(identityHits).toBe(before);
    } finally {
      await browser.close();
    }
  });
  it('honors cancellation and does not replace authentication after the request is aborted', async () => {
    const { GuidedBrowser } = await import('../../src/tools/sdlc/uiVerification/guided/browserSession.js');
    const old = await readFile(path.join(dir, 'auth.json'), 'utf8');
    const controller = new AbortController();
    const browser = await GuidedBrowser.open(await profile(), undefined, { headless: true, signal: controller.signal });
    try {
      const snapshot = await browser.observe();
      const company = snapshot.nodes.find(n => n.name === 'Company')!;
      controller.abort();
      await expect(browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF')).rejects.toMatchObject({
        code: 'NOT_VERIFIED',
      });
      expect(await readFile(path.join(dir, 'auth.json'), 'utf8')).toBe(old);
    } finally {
      await browser.close();
    }
  });
  it('cancels binding promptly without a late authentication save and keeps reads available', async () => {
    const browser = await open();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    try {
      const before = await readFile(path.join(dir, 'auth.json'), 'utf8');
      const snapshot = await browser.observe();
      const company = snapshot.nodes.find(n => n.name === 'Company')!;
      const original = browser.context.storageState.bind(browser.context);
      vi.spyOn(browser.context, 'storageState').mockImplementation(async options => {
        entered();
        await gate;
        return original(options);
      });
      const controller = new AbortController();
      browser.setOperation(controller.signal, 1000);
      const pending = browser.bindCompany(snapshot.snapshotId, company.ref, 'USMF');
      await started;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      browser.setOperation();
      expect((await browser.observe()).phase).toBe('DISCOVERING');
      release();
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(await readFile(path.join(dir, 'auth.json'), 'utf8')).toBe(before);
    } finally {
      release();
      await browser.close();
    }
  });
  it('honors per-call read deadlines and prevents cancelled snapshots replacing newer references', async () => {
    const browser = await open();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      const original = browser.page.locator.bind(browser.page);
      const locatorSpy = vi.spyOn(browser.page, 'locator').mockImplementation((selector, options) => {
        const locator = original(selector, options);
        if (selector === 'body') {
          const snapshot = locator.ariaSnapshotJSON.bind(locator);
          vi.spyOn(locator, 'ariaSnapshotJSON').mockImplementation(async options => {
            await gate;
            return snapshot(options);
          });
        }
        return locator;
      });
      browser.setOperation(undefined, 50);
      await expect(browser.observe()).rejects.toMatchObject({ code: 'CANCELLED' });
      locatorSpy.mockRestore();
      browser.setOperation(undefined, 45000);
      const current = await browser.observe();
      release();
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(await browser.resolve(current.snapshotId, current.nodes[0].ref)).toBeTruthy();
    } finally {
      release();
      await browser.close();
    }
  });
  it('blocks unexpected popups before their first foreign request', async () => {
    const browser = await open();
    try {
      const before = foreignHits;
      await browser.page
        .locator('#popup')
        .click()
        .catch(() => {});
      await expect(browser.observe()).rejects.toMatchObject({ code: 'NOT_VERIFIED' });
      expect(foreignHits).toBe(before);
    } finally {
      await browser.close();
    }
  });
});
