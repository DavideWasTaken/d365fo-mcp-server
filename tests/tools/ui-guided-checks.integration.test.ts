import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type ElementHandle } from 'playwright';
import { measureCheck } from '../../src/tools/sdlc/uiVerification/guided/checks.js';
import { guidedReport, type GuidedCase } from '../../src/tools/sdlc/uiVerification/guided/report.js';
import {
  exampleMission,
  type Criterion,
  type GuidedInput,
  type Mission,
} from '../../src/tools/sdlc/uiVerification/guided/contract.js';
import { safeText } from '../../src/tools/sdlc/uiVerification/report.js';

const common = {
  action: 'check' as const,
  sessionId: 'a'.repeat(64),
  caseId: 'case',
  criterionId: 'result',
  stage: 'criterion' as const,
  snapshotId: 'snapshot',
  final: true,
};
const absentCriterion: Criterion = {
  id: 'result',
  targetDescription: 'Delete button is absent from the observed scope',
  check: 'visible',
  expected: false,
};
const absentInput: Extract<GuidedInput, { action: 'check' }> = {
  ...common,
  absent: { scopeRef: 'scope', role: 'button', name: 'Delete', exact: true },
};

describe('guided checks in real frames', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  async function withPage(fn: (page: Page) => Promise<void>) {
    const page = await browser.newPage();
    try {
      await fn(page);
    } finally {
      await page.close();
    }
  }
  async function resolveElement(page: Page, selector: string): Promise<ElementHandle> {
    const element = await page.locator(selector).elementHandle();
    if (!element) throw new Error('Fixture element missing');
    return element;
  }
  it.each([
    '<input value="G000260436">',
    '<textarea>G000260436</textarea>',
    '<select><option value="G000260436">Order</option></select>',
  ])('rejects text on a value control before comparing: %s', async html => {
    await withPage(async page => {
      await page.setContent(html);
      await expect(
        measureCheck(
          page,
          () => resolveElement(page, 'input,textarea,select'),
          {
            id: 'result',
            targetDescription: 'Order identifier',
            check: 'text',
            expected: 'G000260436',
            match: 'exact',
          },
          { ...common, ref: 'field' },
        ),
      ).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE', message: expect.stringMatching(/value/) });
      expect(
        (
          await measureCheck(
            page,
            () => resolveElement(page, 'input,textarea,select'),
            { id: 'result', targetDescription: 'Order identifier', check: 'value', expected: 'G000260436' },
            { ...common, ref: 'field' },
          )
        ).passed,
      ).toBe(true);
    });
  });
  it('rejects value on ordinary text without waiting for a browser timeout', async () => {
    await withPage(async page => {
      await page.setContent('<span>G000260436</span>');
      await expect(
        measureCheck(
          page,
          () => resolveElement(page, 'span'),
          { id: 'result', targetDescription: 'Order', check: 'value', expected: 'G000260436' },
          { ...common, ref: 'field' },
        ),
      ).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE', message: expect.stringMatching(/text/) });
    });
  });
  it('does not retarget a value check from a label to its associated input', async () => {
    await withPage(async page => {
      await page.setContent('<label for="field">Order</label><input id="field" value="G000260436">');
      await expect(
        measureCheck(
          page,
          () => resolveElement(page, 'label'),
          { id: 'result', targetDescription: 'Order', check: 'value', expected: 'G000260436' },
          { ...common, ref: 'field' },
        ),
      ).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE' });
    });
  });
  it.each([
    '<div role="checkbox">Check</div>',
    '<div role="checkbox" aria-checked="mixed">Check</div>',
    '<div role="switch" aria-checked="unknown">Check</div>',
    '<span>Not a checkbox</span>',
  ])('does not coerce an unsupported checkbox state to false: %s', async html => {
    await withPage(async page => {
      await page.setContent(html);
      await expect(
        measureCheck(
          page,
          () => resolveElement(page, 'body > *'),
          { id: 'result', targetDescription: 'Checkbox', check: 'checked', expected: false },
          { ...common, ref: 'field' },
        ),
      ).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE' });
    });
  });
  it('checks binary native and ARIA states and rejects a native indeterminate state', async () => {
    await withPage(async page => {
      await page.setContent('<input type="checkbox"><div role="switch" aria-checked="false">Switch</div>');
      const criterion: Criterion = {
        id: 'result',
        targetDescription: 'Checkable control',
        check: 'checked',
        expected: false,
      };
      for (const selector of ['input', '[role=switch]'])
        expect(
          (await measureCheck(page, () => resolveElement(page, selector), criterion, { ...common, ref: 'field' }))
            .passed,
        ).toBe(true);
      await page.locator('input').evaluate((element: HTMLInputElement) => {
        element.indeterminate = true;
      });
      await expect(
        measureCheck(page, () => resolveElement(page, 'input'), criterion, { ...common, ref: 'field' }),
      ).rejects.toMatchObject({ code: 'CHECK_NOT_APPLICABLE' });
    });
  });
  it('measures an empty-grid alert without AI review and still detects a genuine text mismatch', async () => {
    await withPage(async page => {
      await page.setContent('<div role="grid"><div role="alert">Niente da visualizzare</div></div>');
      const criterion: Criterion = {
        id: 'result',
        targetDescription: 'Empty grid alert',
        check: 'text',
        match: 'exact',
        expected: 'Niente da visualizzare',
      };
      expect(
        (await measureCheck(page, () => resolveElement(page, '[role=alert]'), criterion, { ...common, ref: 'alert' }))
          .passed,
      ).toBe(true);
      expect(
        (
          await measureCheck(
            page,
            () => resolveElement(page, '[role=alert]'),
            { ...criterion, expected: 'Saved' },
            { ...common, ref: 'alert' },
          )
        ).passed,
      ).toBe(false);
    });
  });
  it.each([
    'type="password"',
    'autocomplete="current-password"',
    'autocomplete="section-login new-password"',
    'autocomplete="one-time-code"',
  ])('refuses a credential value from %s', async attributes => {
    await withPage(async page => {
      await page.setContent(`<input id="secret" ${attributes} value="secret-fixture-123">`);
      await expect(
        measureCheck(
          page,
          () => resolveElement(page, '#secret'),
          { id: 'result', targetDescription: 'Sensitive field', check: 'value', expected: 'secret-fixture-123' },
          { ...common, ref: 'secret' },
        ),
      ).rejects.toThrow(/credential|password|sensitive/i);
    });
  });
  it('redacts credentials echoed in ordinary measured text', async () => {
    await withPage(async page => {
      await page.setContent(
        '<input type="password" value="secret-fixture-123"><div id="echo">Echo: secret-fixture-123</div>',
      );
      const result = await measureCheck(
        page,
        () => resolveElement(page, '#echo'),
        { id: 'result', targetDescription: 'Echo message', check: 'text', match: 'contains', expected: 'Echo:' },
        { ...common, ref: 'echo' },
      );
      expect(result.passed).toBe(true);
      expect(JSON.stringify(result)).not.toContain('secret-fixture-123');
      expect(result.actual).toContain('[REDACTED]');
    });
  });
  it('counts matching controls in nested child frames instead of falsely proving absence', async () => {
    await withPage(async page => {
      await page.setContent('<section id="scope"><iframe id="outer"></iframe></section>');
      await page.locator('#outer').evaluate((node: HTMLIFrameElement) => {
        node.srcdoc = '<iframe srcdoc="&lt;button&gt;Delete&lt;/button&gt;"></iframe>';
      });
      await page.frameLocator('#outer').frameLocator('iframe').getByRole('button', { name: 'Delete' }).waitFor();
      const result = await measureCheck(page, () => resolveElement(page, '#scope'), absentCriterion, absentInput);
      expect(result).toMatchObject({ actual: true, passed: false });
      expect(result.target).toContain('count=1');
    });
  });
  it('includes a frame inside a shadow root but excludes frames outside the observed scope', async () => {
    await withPage(async page => {
      await page.setContent('<section id="scope"><div id="host"></div></section><section id="empty"></section>');
      await page.locator('#host').evaluate(host => {
        const frame = document.createElement('iframe');
        frame.srcdoc = '<button>Delete</button>';
        host.attachShadow({ mode: 'open' }).appendChild(frame);
      });
      await page.frameLocator('#host iframe').getByRole('button', { name: 'Delete' }).waitFor();
      expect(
        (await measureCheck(page, () => resolveElement(page, '#scope'), absentCriterion, absentInput)).passed,
      ).toBe(false);
      expect(
        (await measureCheck(page, () => resolveElement(page, '#empty'), absentCriterion, absentInput)).passed,
      ).toBe(true);
    });
  });
  it('ignores hidden child frames when proving visible absence', async () => {
    await withPage(async page => {
      await page.setContent(
        '<section id="scope"><iframe hidden srcdoc="&lt;button&gt;Delete&lt;/button&gt;"></iframe></section>',
      );
      await page
        .frameLocator('iframe')
        .getByRole('button', { name: 'Delete', includeHidden: true })
        .waitFor({ state: 'attached' });
      expect(
        (await measureCheck(page, () => resolveElement(page, '#scope'), absentCriterion, absentInput)).passed,
      ).toBe(true);
    });
  });
});

function resultCase(definition: Mission['cases'][number]): GuidedCase {
  return {
    id: definition.id,
    name: definition.goal,
    status: 'PASS',
    durationMs: 1,
    steps: [],
    prepared: true,
    begun: true,
    ended: true,
    uncertain: false,
    counters: { calls: 15, interactions: 20, images: 3, recoveries: 0, characters: 40000 },
    checks: Object.fromEntries(
      [...definition.preconditions, ...definition.criteria].map((criterion, index) => [
        criterion.id,
        {
          id: `check-${index}`,
          criterionId: criterion.id,
          stage: index < definition.preconditions.length ? 'precondition' : 'criterion',
          status: 'PASS',
          source: 'measured',
          expected: 'true',
          observed: 'true',
          target: 'observed ref',
        },
      ]),
    ),
  };
}
describe('guided report bounds and escaping', () => {
  it('escapes caller-provided identifiers and evidence references in appended Markdown', () => {
    const mission = structuredClone(exampleMission);
    mission.cases = [mission.cases[0]];
    mission.cases[0].id = 'case\n# Forged [link](https://bad.example)';
    const c = resultCase(mission.cases[0]);
    c.checks.ready.id = 'check\n# forged';
    c.checks.ready.evidenceIds = ['[credential](https://bad.example)'];
    const report = guidedReport(mission, [c], Date.now(), 'https://environment.example');
    expect(report.markdown).not.toContain('\n# Forged');
    expect(report.markdown).toContain(safeText(mission.cases[0].id));
    expect(report.markdown).toContain(safeText(c.checks.ready.evidenceIds[0]));
  });
  it('keeps all case and criterion outcomes, counts and a short journey within the summary budget', () => {
    const mission = structuredClone(exampleMission);
    mission.cases = Array.from({ length: 5 }, (_, c) => ({
      id: `${c}-` + '\\'.repeat(98),
      goal: 'Long case '.repeat(100),
      data: {},
      preconditions: Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}-` + '\\'.repeat(96),
        targetDescription: 'Precondition',
        check: 'enabled' as const,
        expected: true,
      })),
      criteria: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}-` + '\\'.repeat(96),
        targetDescription: 'Criterion',
        check: 'enabled' as const,
        expected: true,
      })),
    }));
    const cases = mission.cases.map(definition => {
      const c = resultCase(definition);
      c.steps = Array.from({ length: 50 }, () => ({
        label: '\\'.repeat(2000),
        expected: 'Complete',
        observed: '\\'.repeat(2000),
        completed: true,
      }));
      return c;
    });
    delete cases[4].checks[mission.cases[4].criteria[9].id];
    const report = guidedReport(mission, cases, Date.now(), 'https://environment.example');
    expect(JSON.stringify({ status: report.status, cases: report.cases }).length).toBeLessThanOrEqual(15000);
    expect(report.cases).toHaveLength(5);
    expect(report.cases.map(c => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'NOT_VERIFIED']);
    for (const c of report.cases) {
      expect(c.checks).toHaveLength(20);
      expect(c.counters.interactions).toBe(20);
      expect(c.journey.length).toBeGreaterThan(0);
      expect(c.journey.length).toBeLessThanOrEqual(5);
    }
    expect(report.cases[4].checks[19].status).toBe('NOT_VERIFIED');
  });
});
