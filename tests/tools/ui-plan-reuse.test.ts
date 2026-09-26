import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { examplePlan } from '../../src/tools/sdlc/uiVerification/contract.js';
const run = vi.hoisted(() =>
  vi.fn(async (_profile: unknown, plan: any) => ({
    status: 'PASS',
    durationMs: 1,
    reportPath: 'report.md',
    planPath: 'plan.json',
    cases: plan.cases.map((c: any) => ({ name: c.name, status: 'PASS', durationMs: 1, steps: [] })),
  })),
);
vi.mock('../../src/tools/sdlc/uiVerification/runner.js', () => ({ runVerification: run }));
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it('loads a saved validated plan and forwards explicit timing settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ui-plan-'));
  dirs.push(dir);
  const planPath = path.join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify(examplePlan));
  const result = await verifyUiCustomizationTool({ action: 'run', planPath, timeouts: { stepTimeoutMs: 60000 } });
  expect(result).not.toHaveProperty('isError', true);
  expect(run).toHaveBeenCalledWith(
    undefined,
    examplePlan,
    expect.objectContaining({ timeouts: { stepTimeoutMs: 60000 } }),
  );
});
it('rejects malformed and oversized plans before launching a browser', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ui-plan-'));
  dirs.push(dir);
  const planPath = path.join(dir, 'plan.json');
  for (const content of ['{}', 'not JSON', ' '.repeat(2 * 1024 * 1024 + 1)]) {
    await writeFile(planPath, content);
    expect(await verifyUiCustomizationTool({ action: 'run', planPath })).toHaveProperty('isError', true);
  }
  expect(run).not.toHaveBeenCalled();
});
