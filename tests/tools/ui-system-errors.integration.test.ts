import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { inspectSystemErrors } from '../../src/tools/sdlc/uiVerification/systemErrors.js';

describe('D365 system error detector', () => {
  let browser: Browser;
  let page: Page;
  const origin = 'http://ui-fixture.test';
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    await page.goto(origin);
  });
  afterAll(async () => {
    await browser.close();
  });
  it('captures Italian platform errors independently of business messages and nested regions', async () => {
    await page.setContent(
      '<div role="alertdialog"><h2>Più errori ricevuti</h2><div role="alert">Impossibile aprire l\'oggetto menu item AVABom.</div><p>Nessuna distinta base trovata</p></div>',
    );
    const result = await inspectSystemErrors(page, origin);
    expect(result.complete).toBe(true);
    expect(result.errors.map(e => e.code).sort()).toEqual(['MENU_ITEM_OPEN_FAILED', 'MULTIPLE_SYSTEM_ERRORS']);
  });
  it('recognizes English menu errors while ignoring unrelated expected negative messages', async () => {
    await page.setContent(
      '<div role="dialog">Unable to open menu item MyAction.</div><div role="alert">No BOM found</div>',
    );
    expect((await inspectSystemErrors(page, origin)).errors).toHaveLength(1);
    await page.setContent(
      '<div role="alert">Record not found. Error: missing BOM</div><article>Unable to open menu item is explained here</article>',
    );
    expect((await inspectSystemErrors(page, origin)).errors).toEqual([]);
  });
  it('ignores hidden dialogs, hidden descendant messages and hidden frames', async () => {
    await page.setContent(
      '<div hidden role="dialog">Unable to open menu item</div><div role="dialog"><span aria-hidden="true">Multiple errors received</span>Expected warning</div><iframe hidden srcdoc="&lt;div role=alert&gt;Unable to open menu item&lt;/div&gt;"></iframe>',
    );
    const result = await inspectSystemErrors(page, origin);
    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
  });
  it('inspects visible same-origin frames and open shadow roots', async () => {
    await page.setContent(
      '<div id="host"></div><iframe srcdoc="&lt;div role=alert&gt;Unable to open menu item&lt;/div&gt;"></iframe>',
    );
    await page.locator('#host').evaluate(el => {
      el.attachShadow({ mode: 'open' }).innerHTML = '<div role="alertdialog">Più errori ricevuti</div>';
    });
    await page.locator('iframe').contentFrame().getByRole('alert').waitFor();
    expect((await inspectSystemErrors(page, origin)).errors).toHaveLength(2);
  });
  it('reads composed text when the dialog role is outside a shadow root or uses display contents', async () => {
    await page.setContent(
      '<div role="dialog"><span id="message"></span></div><div role="alert" style="display:contents"><span>Più errori ricevuti</span></div>',
    );
    await page.locator('#message').evaluate(el => {
      el.attachShadow({ mode: 'open' }).innerHTML = '<p>Unable to open menu item</p>';
    });
    const result = await inspectSystemErrors(page, origin);
    expect(result.complete).toBe(true);
    expect(result.errors).toHaveLength(2);
  });
  it('ignores invisible frame hosts, including enclosing shadow ancestors', async () => {
    await page.setContent(
      '<iframe style="opacity:0" srcdoc="&lt;div role=alert&gt;Unable to open menu item&lt;/div&gt;"></iframe><div id="hidden-host" aria-hidden="true"></div>',
    );
    await page.locator('#hidden-host').evaluate(el => {
      el.attachShadow({ mode: 'open' }).innerHTML =
        '<iframe srcdoc="&lt;div role=alert&gt;Più errori ricevuti&lt;/div&gt;"></iframe>';
    });
    await page.locator('iframe').first().contentFrame().getByRole('alert').waitFor();
    await page.locator('#hidden-host iframe').contentFrame().getByRole('alert').waitFor();
    const result = await inspectSystemErrors(page, origin);
    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
  });
  it('matches split styled text and line breaks in a visible system dialog', async () => {
    await page.setContent('<div role="alert">Unable to <b>open</b>\n menu item</div>');
    expect((await inspectSystemErrors(page, origin)).errors).toHaveLength(1);
  });
  it('does not inspect an identity provider and reports incomplete inspection', async () => {
    await page.goto('http://identity.test');
    await page.setContent('<div role="alert">Unable to open menu item secret-token</div>');
    const result = await inspectSystemErrors(page, origin);
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    await page.goto(origin);
  });
  it('redacts sensitive values and reports truncation rather than a clean result', async () => {
    await page.setContent(
      '<input type="password" value="Unable to open menu item"><div role="alert">Unable to open menu item private details</div>',
    );
    expect(JSON.stringify(await inspectSystemErrors(page, origin))).not.toContain('Unable to open menu item');
    await page.setContent(`<div role="alert">${'x'.repeat(40000)}Unable to open menu item</div>`);
    expect((await inspectSystemErrors(page, origin)).complete).toBe(false);
  });
});
