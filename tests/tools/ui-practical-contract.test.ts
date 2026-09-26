import { describe, expect, it } from 'vitest';
import { InputSchema, PlanSchema, ProfileSchema, examplePlan } from '../../src/tools/sdlc/uiVerification/contract.js';
import { aggregateStatus, summarizeReport } from '../../src/tools/sdlc/uiVerification/report.js';

describe('practical UI verification contract', () => {
  it('accepts one to five explicit cases, keeping two in the example', () => {
    expect(examplePlan.cases).toHaveLength(2);
    for (const count of [1, 2, 3, 5]) {
      const plan = { ...examplePlan, cases: Array.from({ length: count }, () => examplePlan.cases[0]) };
      expect(PlanSchema.safeParse(plan).success).toBe(true);
      expect(aggregateStatus(Array.from({ length: count }, () => 'PASS'))).toBe('PASS');
    }
    for (const count of [0, 6])
      expect(PlanSchema.safeParse({ ...examplePlan, cases: Array(count).fill(examplePlan.cases[0]) }).success).toBe(
        false,
      );
    expect(aggregateStatus([])).toBe('NOT_VERIFIED');
  });
  it('supports scoped text contains without weakening exact company/value checks', () => {
    const plan = structuredClone(examplePlan) as any;
    plan.cases[0].scope = '#active-form';
    plan.cases[0].steps = [
      { action: 'assert', selector: '#message', check: 'text', match: 'contains', expected: 'positive' },
    ];
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    plan.cases[0].steps[0].expected = '';
    expect(PlanSchema.safeParse(plan).success).toBe(false);
    plan.cases[0].steps[0] = {
      action: 'assert',
      selector: '#amount',
      check: 'value',
      match: 'contains',
      expected: '1',
    };
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });
  it('accepts bounded configurable timeouts and requires exactly one plan source', () => {
    expect(
      InputSchema.safeParse({
        action: 'run',
        planPath: 'saved.json',
        timeouts: { stepTimeoutMs: 60000, navigationTimeoutMs: 120000, caseTimeoutMs: 300000 },
      }).success,
    ).toBe(true);
    for (const value of [
      {},
      { plan: examplePlan, planPath: 'saved.json' },
      { plan: examplePlan, timeouts: { stepTimeoutMs: 120001 } },
    ])
      expect(InputSchema.safeParse({ action: 'run', ...value }).success).toBe(false);
  });
  it('keeps authentication separate and limits authentication origins', () => {
    expect(
      InputSchema.safeParse({ action: 'authenticate', company: 'USMF', companySelector: '#company' }).success,
    ).toBe(true);
    expect(
      InputSchema.safeParse({ action: 'authenticate', company: 'USMF', companySelector: '#company', headless: true })
        .success,
    ).toBe(false);
    const profile = {
      baseUrl: 'https://dev.example',
      storageState: 'auth.json',
      outputDir: 'reports',
      channel: 'msedge',
    };
    expect(
      ProfileSchema.safeParse({ ...profile, authenticationOrigins: ['https://login.microsoftonline.com'] }).success,
    ).toBe(true);
    for (const origin of [
      'https://login.example/path',
      'https://user:secret@login.example',
      'http://login.example',
      'https://*.example',
    ])
      expect(ProfileSchema.safeParse({ ...profile, authenticationOrigins: [origin] }).success).toBe(false);
  });
  it('keeps all five outcomes in bounded, valid inline JSON', () => {
    const value = '\u0001'.repeat(2000);
    const text = summarizeReport({
      status: 'FAIL',
      durationMs: 1,
      reportPath: 'report.md',
      planPath: 'plan.json',
      cases: Array.from({ length: 5 }, (_, i) => ({
        name: value,
        status: i === 4 ? 'FAIL' : 'PASS',
        durationMs: 1,
        steps: Array.from({ length: 32 }, () => ({ label: value, expected: value, observed: value, completed: true })),
      })),
    } as any);
    expect(text.length).toBeLessThanOrEqual(20000);
    const result = JSON.parse(text);
    expect(result.cases).toHaveLength(5);
    expect(result.cases[4].status).toBe('FAIL');
    expect(result.planPath).toBe('plan.json');
  });
});
