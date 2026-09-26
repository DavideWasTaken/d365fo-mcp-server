import { describe, expect, it } from 'vitest';
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
import {
  GuidedInputSchema,
  exampleMission,
  CriterionSchema,
  LimitsSchema,
} from '../../src/tools/sdlc/uiVerification/guided/contract.js';

describe('guided UI contract', () => {
  it('provides 30 calls by default and requires an explicit row-count basis', () => {
    expect(LimitsSchema.parse({}).calls).toBe(30);
    const criterion = { id: 'rows', targetDescription: 'Filtered orders', check: 'rowCount', expected: 0 };
    expect(CriterionSchema.safeParse(criterion).success).toBe(false);
    for (const basis of ['rendered', 'total'])
      expect(CriterionSchema.safeParse({ ...criterion, basis }).success).toBe(true);
    expect(CriterionSchema.safeParse({ ...criterion, basis: 'total', expected: -1 }).success).toBe(false);
  });
  it('publishes the guided mission and action contract separately without browser startup', async () => {
    const result = await verifyUiCustomizationTool({ action: 'contract', topic: 'guided' });
    expect(result).not.toHaveProperty('isError', true);
    const contract = JSON.parse(result.content[0].text);
    expect(contract.example.action).toBe('start');
    expect(contract.example.mission.cases).toHaveLength(2);
    expect(contract.rules.join(' ')).toContain('WRITE_UNCERTAIN');
    expect(result.content[0].text.length).toBeLessThan(24000);
  });
  it('rejects non-HTTP environment URLs and cannot use measured checks as AI reviews', () => {
    expect(
      GuidedInputSchema.safeParse({ action: 'start', mission: exampleMission, environmentUrl: 'file:///C:/private' })
        .success,
    ).toBe(false);
    expect(
      GuidedInputSchema.safeParse({
        action: 'check',
        sessionId: 'a'.repeat(64),
        caseId: 'positive',
        criterionId: 'result',
        ref: 'e1',
      }).success,
    ).toBe(false);
  });
});
