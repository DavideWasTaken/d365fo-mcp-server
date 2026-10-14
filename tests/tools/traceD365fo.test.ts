import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceD365foTool } from '../../src/tools/sdlc/traceD365fo.js';
import { TraceInputSchema } from '../../src/tools/sdlc/trace/contract.js';
import { captureFileName, isInside, sizeLimitMB, requiredFreeMB } from '../../src/tools/sdlc/trace/capture.js';
import { analysisFiles, analysisState, boundedAnalysis } from '../../src/tools/sdlc/trace/analysis.js';
import { readRememberedOutputDir, rememberOutputDir, resolveTraceConfig } from '../../src/config/trace.js';
import { isToolEnabled } from '../../src/server/serverMode.js';

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
  vi.stubEnv('DB_PATH', path.join(dir, 'index', 'symbols.db'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('trace_d365fo', () => {
  it('returns the contract even when tracing is disabled', async () => {
    const contract = parse(await traceD365foTool({ action: 'contract' }, {}));
    expect(contract.rules.some((r: string) => /customer data/.test(r))).toBe(true);
    expect(contract.inputSchema).toBeDefined();
  });

  it('refuses every other action while disabled', async () => {
    const r = await traceD365foTool({ action: 'status' }, {});
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe('TRACE_DISABLED');
  });

  it('is published only when tracing is enabled', () => {
    expect(isToolEnabled('trace_d365fo', 'full', 'full')).toBe(false);
    vi.stubEnv('D365FO_TRACE_ENABLED', 'true');
    expect(isToolEnabled('trace_d365fo', 'full', 'full')).toBe(true);
    // It drives logman on the VM: never on the Azure read-only server.
    expect(isToolEnabled('trace_d365fo', 'read-only', 'full')).toBe(false);
  });

  it('validates input strictly', () => {
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'auto', seconds: 5 }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'later' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'manual', label: 'a b' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'analyze', scope: 'subtree' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'analyze', scope: 'subtree', focus: ['BOMCalc'] }).success).toBe(true);
    expect(TraceInputSchema.safeParse({ action: 'analyze', focus: ['A;B'] }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'delete', file: 'C:\\x\\notes.txt' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'stop', extra: 1 }).success).toBe(false);
  });

  it('sizes a capture from its duration, within the setup limit', () => {
    expect(sizeLimitMB(60, 4096)).toBe(3000);
    expect(sizeLimitMB(120, 4096)).toBe(4096);
    expect(sizeLimitMB(1, 4096)).toBe(200);
    expect(requiredFreeMB(3000)).toBe(4024);
  });

  it('names captures by time and label', () => {
    const name = captureFileName('K:\\Temp\\t', 'bom', new Date(2026, 9, 14, 9, 5, 7));
    expect(path.basename(name)).toBe('d365fo-20261014-090507-bom.etl');
  });

  it('confines delete to the trace folder', () => {
    expect(isInside('K:\\Temp\\t\\a.etl', 'K:\\Temp\\t')).toBe(true);
    expect(isInside('k:\\temp\\T\\a.etl', 'K:\\Temp\\t\\')).toBe(true);
    expect(isInside('K:\\Temp\\t2\\a.etl', 'K:\\Temp\\t')).toBe(false);
    expect(isInside('K:\\Temp\\t\\..\\a.etl', 'K:\\Temp\\t')).toBe(false);
  });

  it('remembers the chosen folder beside the index, and config wins over it', () => {
    expect(readRememberedOutputDir()).toBeUndefined();
    const file = rememberOutputDir('E:\\Traces');
    expect(path.dirname(file)).toBe(path.join(dir, 'index'));
    expect(resolveTraceConfig()).toMatchObject({ outputDir: 'E:\\Traces', outputDirSource: 'remembered' });
    vi.stubEnv('D365FO_TRACE_DIR', 'F:\\Configured');
    expect(resolveTraceConfig()).toMatchObject({ outputDir: 'F:\\Configured', outputDirSource: 'config' });
  });

  it('rejects limits outside their range', () => {
    vi.stubEnv('D365FO_TRACE_MAX_SECONDS', '5');
    expect(() => resolveTraceConfig()).toThrow(/D365FO_TRACE_MAX_SECONDS/);
  });

  it('keys analyses by options and reads a finished or failed result', () => {
    const etl = path.join(dir, 'a.etl');
    fs.writeFileSync(etl, 'x');
    const a = analysisFiles(etl, { focus: ['X'] });
    expect(analysisFiles(etl, { focus: ['X'] }).result).toBe(a.result);
    expect(analysisFiles(etl, { focus: ['Y'] }).result).not.toBe(a.result);
    expect(analysisState(a)).toBeUndefined();
    fs.writeFileSync(a.result, JSON.stringify({ error: 'boom' }));
    expect(analysisState(a)).toEqual({ state: 'failed', error: 'boom' });
    fs.writeFileSync(a.result, JSON.stringify({ totals: {} }));
    expect(analysisState(a)?.state).toBe('done');
  });

  it('shortens rankings to fit the reply without breaking the JSON', () => {
    const row = { statement: 'S'.repeat(300), executions: 1 };
    const result = { totals: { sqlStatements: 1 }, topSqlByTime: Array(40).fill(row), topSqlByCount: Array(40).fill(row), caveats: ['c'] };
    const bounded = boundedAnalysis(result, 'r.json', 24000);
    const text = JSON.stringify(bounded);
    expect(text.length).toBeLessThanOrEqual(24000);
    expect(bounded.truncated).toMatch(/r\.json/);
    expect(bounded.caveats).toEqual(['c']);
    expect((bounded.topSqlByTime as unknown[]).length).toBeGreaterThan(3);
    expect(result.topSqlByTime).toHaveLength(40); // the original is left alone
    expect(boundedAnalysis({ totals: {} }, 'r.json').truncated).toBeUndefined();
  });
});
