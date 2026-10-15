import { describe, expect, it } from 'vitest';
import { summarizeBpOutput } from '../../src/tools/sdlc/buildProject.js';
import { parseBpFindings } from '../../src/tools/sdlc/runBpCheck.js';

// build_d365fo_project is uncapped: a model-wide bpCheck on ~5,000 warnings put
// 2.7 MB into one build result. Past 12,000 characters the result carries this.
describe('summarizeBpOutput', () => {
  const finding = (i: number, rule = 'BPUpgradeCodeRecId') =>
    `${rule}: dynamics://Class/MyClass${i}/Method/run\nWarning AxClass [(1,1),(2,2)] Rule text ${i}`;
  const output = (body: string[], tally = '') =>
    ['⚠️ BP Check completed with issues', '', ...body, tally].join('\n');

  it('keeps the verdict, counts findings by rule and names where the full text is', () => {
    const body = [
      ...Array.from({ length: 30 }, (_, i) => finding(i)),
      ...Array.from({ length: 5 }, (_, i) => finding(100 + i, 'BPErrorEDTNotMigrated')),
    ];
    const text = output(body);
    const summary = summarizeBpOutput(text, parseBpFindings(text), 'K:\\logs\\build.log.bp.txt');
    expect(summary.split('\n')[0]).toBe('⚠️ BP Check completed with issues');
    expect(summary).toMatch(/30 × BPUpgradeCodeRecId/);
    expect(summary).toMatch(/5 × BPErrorEDTNotMigrated/);
    expect(summary.indexOf('BPUpgradeCodeRecId')).toBeLessThan(summary.indexOf('BPErrorEDTNotMigrated'));
    expect(summary).toContain('saved to: K:\\logs\\build.log.bp.txt');
    expect(summary).toContain('run_bp_check');
    expect(summary.length).toBeLessThan(text.length);
  });

  it("leads with xppbp's own totals, which can exceed what the parser recognises", () => {
    const text = output(Array.from({ length: 3 }, (_, i) => finding(i)), 'Errors: 0\nWarnings: 5291');
    const summary = summarizeBpOutput(text, parseBpFindings(text));
    expect(summary).toContain('xppbp totals: Errors 0, Warnings 5291.');
    expect(summary).toContain('Counted below: 3 finding(s) the parser recognises');
    expect(summary).not.toContain('saved to');
  });

  it('stays bounded however many rules and findings there are', () => {
    const body = Array.from({ length: 2_000 }, (_, i) => finding(i, `BPRule${i % 60}`));
    const text = output(body);
    const summary = summarizeBpOutput(text, parseBpFindings(text));
    expect(summary).toContain('… and 35 more rule(s)');
    expect(summary).toContain('First 15 finding(s):');
    expect(summary.length).toBeLessThan(5_000);
  });
});
