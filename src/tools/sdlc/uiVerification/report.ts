export type Status = 'PASS' | 'FAIL' | 'NOT_VERIFIED';
export interface StepResult {
  label: string;
  expected: string;
  observed: string;
  completed: boolean;
}
export interface CaseResult {
  name: string;
  status: Status;
  durationMs: number;
  steps: StepResult[];
  reason?: string;
  screenshot?: string;
}
export interface VerificationReport {
  requirement: string;
  buildReference: { reference: string; ready: boolean };
  company: string;
  environment: string;
  startedAt: string;
  durationMs: number;
  status: Status;
  cases: CaseResult[];
  planPath?: string;
  timeouts?: { stepTimeoutMs: number; navigationTimeoutMs: number; caseTimeoutMs: number };
}
export function aggregateStatus(statuses: Status[]): Status {
  return statuses.includes('FAIL')
    ? 'FAIL'
    : statuses.length < 1 || statuses.length > 5 || statuses.includes('NOT_VERIFIED')
      ? 'NOT_VERIFIED'
      : 'PASS';
}
export function safeText(value: unknown, max = 2000): string {
  return String(value)
    .slice(0, max)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}
export function renderReport(r: VerificationReport): string {
  const lines = [
    '# UI customization verification',
    '',
    `Requirement: ${safeText(r.requirement)}`,
    `Build: ${safeText(r.buildReference.reference)} — caller-declared, not browser-attested; ready: ${r.buildReference.ready}`,
    `Environment: ${safeText(r.environment)}`,
    `Company: ${safeText(r.company)}`,
    `Started: ${safeText(r.startedAt)}; duration: ${r.durationMs} ms`,
    `Overall: **${r.status}**`,
    ...(r.timeouts
      ? [
          `Timeouts: step ${r.timeouts.stepTimeoutMs} ms; navigation ${r.timeouts.navigationTimeoutMs} ms; case ${r.timeouts.caseTimeoutMs} ms`,
        ]
      : []),
    '',
  ];
  for (const c of r.cases) {
    lines.push(
      `## ${safeText(c.name)}`,
      `Status: **${c.status}**; duration: ${c.durationMs} ms`,
      '',
      '| Step attempted | Completed | Expected | Observed |',
      '|---|---|---|---|',
    );
    for (const s of c.steps)
      lines.push(
        `| ${safeText(s.label)} | ${s.completed ? 'yes' : 'no'} | ${safeText(s.expected)} | ${safeText(s.observed)} |`,
      );
    if (c.reason) lines.push('', `Stopped: ${safeText(c.reason)}`);
    if (c.screenshot)
      lines.push('', `Local error screenshot: [open screenshot](<${encodeURI(c.screenshot.replace(/\\/g, '/'))}>)`);
    lines.push('');
  }
  lines.push(
    `Coverage: only these ${r.cases.length} scenarios and their explicit assertions. Unexecuted steps and other requirement criteria are not covered.`,
  );
  return lines.join('\n');
}

export function summarizeReport(result: VerificationReport & { reportPath: string }): string {
  let limit = 160;
  const summary = () =>
    JSON.stringify({
      status: result.status,
      cases: result.cases.map(c => ({
        name: c.name.slice(0, limit),
        status: c.status,
        durationMs: c.durationMs,
        reason: c.reason?.slice(0, limit),
        journey: c.steps.map(s => ({
          step: s.label.slice(0, limit),
          completed: s.completed,
          expected: s.expected.slice(0, limit),
          observed: s.observed.slice(0, limit),
        })),
      })),
      durationMs: result.durationMs,
      reportPath: result.reportPath,
      planPath: result.planPath,
      buildAttestation: 'Caller-declared; not browser-attested',
      evidenceNote: 'Inline evidence is abbreviated; the local report contains full bounded evidence.',
    });
  let text = summary();
  while (text.length > 20000 && limit > 0) {
    limit = Math.floor(limit / 2);
    text = summary();
  }
  if (text.length > 20000)
    return JSON.stringify({
      status: result.status,
      cases: result.cases.map(c => ({ name: c.name.slice(0, 80), status: c.status, durationMs: c.durationMs })),
      reportPath: result.reportPath,
      planPath: result.planPath,
      evidenceNote: 'Detailed evidence is in the local report.',
    });
  return text;
}
