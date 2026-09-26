import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureCheck } from '../../src/tools/sdlc/uiVerification/guided/checks.js';

describe('measured grid rows', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser.close();
  });
  const header = '<div role="row" aria-rowindex="1"><div role="columnheader">Order</div></div>';
  const row = (index: number, text = 'Order') =>
    `<div role="row" aria-rowindex="${index}"><div role="gridcell">${text}</div></div>`;
  async function measure(basis: 'rendered' | 'total', expected = 0) {
    return measureCheck(
      page,
      async () => (await page.locator('#grid').elementHandle())!,
      { id: 'rows', targetDescription: 'Orders', check: 'rowCount', basis, expected } as any,
      {
        action: 'check',
        sessionId: 'a'.repeat(64),
        caseId: 'positive',
        criterionId: 'rows',
        stage: 'criterion',
        final: true,
        snapshotId: 's',
        ref: 'grid',
      },
    );
  }
  it('measures data rows separately from headers and distinguishes a virtualized total', async () => {
    await page.setContent(`<div id="grid" role="grid" aria-rowcount="101">${header}${row(2)}${row(3)}</div>`);
    expect(await measure('rendered', 2)).toMatchObject({ actual: 2, passed: true });
    expect(await measure('total', 100)).toMatchObject({ actual: 100, passed: true });
    expect((await measure('total', 2)).passed).toBe(false);
  });
  it('measures an explicitly empty total without requiring an AI judgement', async () => {
    await page.setContent(`<div id="grid" role="grid" aria-rowcount="1">${header}</div>`);
    expect(await measure('total', 0)).toMatchObject({ actual: 0, passed: true });
    await page.setContent('<div id="grid" role="grid" aria-rowcount="0" style="height:20px"></div>');
    expect(await measure('total', 0)).toMatchObject({ actual: 0, passed: true });
  });
  it('never interprets absent total metadata or an unloaded viewport as an empty dataset', async () => {
    await page.setContent(`<div id="grid" role="grid">${header}</div>`);
    await expect(measure('total')).rejects.toMatchObject({
      code: 'CHECK_NOT_APPLICABLE',
      message: expect.stringContaining('aria-rowcount'),
    });
    expect(await measure('rendered')).toMatchObject({
      actual: 0,
      passed: true,
      target: expect.stringContaining('rendered'),
    });
  });
  it.each(['-1', 'bogus', '1'])('rejects unknown or inconsistent total %s', async count => {
    await page.setContent(`<div id="grid" role="grid" aria-rowcount="${count}">${header}${row(2)}</div>`);
    await expect(measure('total')).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE' });
  });
  it('rejects loading, external row ownership and incomplete header/index evidence', async () => {
    for (const html of [
      `<div aria-busy="true"><div id="grid" role="grid" aria-rowcount="1">${header}</div></div>`,
      `<div id="grid" role="grid" aria-rowcount="1" aria-owns="outside">${header}</div>`,
      `<div id="grid" role="grid" aria-rowcount="5">${row(3)}</div>`,
      `<div id="grid" role="grid" aria-rowcount="101">${header}${row(50)}${row(51)}</div>`,
      `<div id="grid" role="grid" aria-rowcount="101">${header}</div>`,
      `<div id="grid" role="grid" aria-rowcount="3">${header}${row(2)}${row(2)}</div>`,
    ]) {
      await page.setContent(html);
      await expect(measure('total')).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE' });
    }
  });
  it('excludes nested grid rows and hidden rows from rendered data count', async () => {
    await page.setContent(
      `<div id="grid" role="grid">${header}${row(2, `<div role="grid">${row(1)}</div>`)}<div hidden>${row(3)}</div></div>`,
    );
    expect(await measure('rendered', 1)).toMatchObject({ actual: 1, passed: true });
  });
  it('counts native table data rows and excludes the column header', async () => {
    await page.setContent(
      '<table id="grid"><thead><tr><th>Order</th></tr></thead><tbody><tr><td>One</td></tr><tr><td>Two</td></tr></tbody></table>',
    );
    expect(await measure('rendered', 2)).toMatchObject({ actual: 2, passed: true });
  });
  it('counts rows laid out with display:contents through their visible cells', async () => {
    await page.setContent(
      '<div id="grid" role="grid"><div role="row" style="display:contents"><div role="gridcell">One</div></div></div>',
    );
    expect(await measure('rendered', 1)).toMatchObject({ actual: 1, passed: true });
  });
  it('refuses incomplete row enumeration through shadow DOM', async () => {
    await page.setContent('<div id="grid" role="grid" style="height:20px"><div id="host"></div></div>');
    await page.locator('#host').evaluate(el => {
      el.attachShadow({ mode: 'open' }).innerHTML = '<div role="row"><span role="gridcell">One</span></div>';
    });
    await expect(measure('rendered')).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE' });
  });
  it('supports ordinary visible form headings with the existing text check', async () => {
    await page.setContent('<h2 id="grid">Ordini fornitore</h2>');
    const result = await measureCheck(
      page,
      async () => (await page.locator('#grid').elementHandle())!,
      { id: 'title', targetDescription: 'Form heading', check: 'text', expected: 'Ordini fornitore', match: 'exact' },
      {
        action: 'check',
        sessionId: 'a'.repeat(64),
        caseId: 'positive',
        criterionId: 'title',
        stage: 'criterion',
        final: true,
        snapshotId: 's',
        ref: 'title',
      },
    );
    expect(result).toMatchObject({ actual: 'Ordini fornitore', passed: true });
  });
});
