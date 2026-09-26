import { capToolResponse } from '../../src/tools/responseCaps.js';
import { describe, it, expect } from 'vitest';
import { PlanSchema, ProfileSchema, examplePlan } from '../../src/tools/sdlc/uiVerification/contract.js';
import { aggregateStatus, renderReport, summarizeReport } from '../../src/tools/sdlc/uiVerification/report.js';
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
import { toolSchemas } from '../../src/server/toolSchemas/index.js';
import { CORE_TOOLS, LOCAL_TOOLS } from '../../src/server/serverMode.js';
import { DEDUP_EXCLUDED_TOOLS, MUTATING_TOOLS } from '../../src/utils/callDedup.js';
import { registerToolHandler } from '../../src/tools/toolHandler.js';
import { TOOL_ANNOTATIONS } from '../../src/server/toolAnnotations.js';

describe('UI verification contract', () => {
  it('accepts the executable two-case example and rejects unsafe/unbounded plans', () => {
    expect(PlanSchema.safeParse(examplePlan).success).toBe(true);
    for (const plan of [
      { ...examplePlan, cases: [] },
      { ...examplePlan, code: 'run()' },
      { ...examplePlan, cases: examplePlan.cases.map(c => ({ ...c, preconditions: [] })) },
      {
        ...examplePlan,
        cases: examplePlan.cases.map(c => ({ ...c, steps: [{ action: 'click', selector: '#save' }] })),
      },
      { ...examplePlan, cases: examplePlan.cases.map(c => ({ ...c, steps: Array(21).fill(c.steps[0]) })) },
      {
        ...examplePlan,
        cases: examplePlan.cases.map(c => ({
          ...c,
          steps: [{ action: 'assert', selector: '#ok', check: 'enabled', expected: 'yes' }],
        })),
      },
    ])
      expect(PlanSchema.safeParse(plan).success).toBe(false);
    expect(ProfileSchema.safeParse({ baseUrl: 'javascript:alert(1)', storageState: 'a', outputDir: 'b' }).success).toBe(
      false,
    );
  });
  it('returns the full contract on demand, keeping the published schema compact', async () => {
    const result = await verifyUiCustomizationTool({ action: 'contract' });
    const contract = JSON.parse(result.content[0].text);
    expect(contract.planSchema.additionalProperties).toBe(false);
    expect(contract.planSchema.properties.cases.minItems).toBe(1);
    expect(PlanSchema.safeParse(contract.example.plan).success).toBe(true);
    const schema = toolSchemas.find(t => t.name === 'verify_ui_customization');
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema).length).toBeLessThan(1000);
  });
  it('returns complete contract JSON through the central dispatcher without waiting for DB', async () => {
    let handler: any;
    registerToolHandler(
      {
        setRequestHandler: (_schema: unknown, h: unknown) => {
          handler = h;
        },
        sendLoggingMessage: async () => {},
      } as any,
      { dbReady: new Promise(() => {}) } as any,
    );
    const result = await handler(
      { method: 'tools/call', params: { name: 'verify_ui_customization', arguments: { action: 'contract' } } },
      {},
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.planSchema.properties.cases.items.properties.steps.contains.properties.action.const).toBe('assert');
    expect(result.content[0].text.length).toBeLessThan(24000);
  });
  it('registers local core mutations without deduplication', () => {
    for (const set of [CORE_TOOLS, LOCAL_TOOLS, DEDUP_EXCLUDED_TOOLS, MUTATING_TOOLS])
      expect(set.has('verify_ui_customization')).toBe(true);
    expect(TOOL_ANNOTATIONS.verify_ui_customization).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(TOOL_ANNOTATIONS.verify_ui_customization.readOnlyHint).not.toBe(true);
    expect(TOOL_ANNOTATIONS.verify_ui_customization.idempotentHint).not.toBe(true);
  });
  it('never passes unready builds or missing authentication', async () => {
    const result = await verifyUiCustomizationTool({
      action: 'run',
      profilePath: 'does-not-exist.json',
      plan: examplePlan,
    });
    expect(result.content[0].text).toContain('NOT_VERIFIED');
    expect(result.content[0].text).not.toContain('PASS');
  });
  it('gives functional failure precedence and escapes bounded report evidence', () => {
    expect(aggregateStatus(['PASS', 'NOT_VERIFIED'])).toBe('NOT_VERIFIED');
    expect(aggregateStatus(['FAIL', 'NOT_VERIFIED'])).toBe('FAIL');
    expect(aggregateStatus(['PASS', 'PASS'])).toBe('PASS');
    const md = renderReport({
      requirement: '<script>|\n# heading',
      buildReference: { reference: 'b', ready: true },
      company: 'USMF',
      environment: 'https://test.invalid',
      startedAt: 'now',
      durationMs: 1,
      status: 'NOT_VERIFIED',
      cases: [
        {
          name: 'case',
          status: 'NOT_VERIFIED',
          durationMs: 1,
          steps: [{ label: 'step', expected: 'x', observed: 'z'.repeat(10000), completed: false }],
          reason: 'blocked',
        },
      ],
    });
    expect(md).not.toContain('<script>');
    expect(md.length).toBeLessThan(5000);
    expect(md).toContain('not browser-attested');
  });
  it('keeps maximum-size evidence valid JSON through the response cap', () => {
    const huge = '\u0001'.repeat(2000);
    const report: any = {
      status: 'PASS',
      durationMs: 1,
      reportPath: 'C:/reports/report.md',
      cases: Array.from({ length: 2 }, () => ({
        name: huge,
        status: 'PASS',
        durationMs: 1,
        steps: Array.from({ length: 32 }, () => ({ label: huge, expected: huge, observed: huge, completed: true })),
      })),
    };
    const text = summarizeReport(report);
    expect(text.length).toBeLessThanOrEqual(20000);
    const capped = capToolResponse('verify_ui_customization', { content: [{ type: 'text', text }] });
    expect(JSON.parse(capped.content[0].text).cases).toHaveLength(2);
    expect(JSON.parse(capped.content[0].text).cases[0].journey).toHaveLength(32);
  });
});
