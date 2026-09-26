import { aggregateStatus, renderReport, safeText, type CaseResult, type Status } from '../report.js';
import type { Mission, Criterion } from './contract.js';

export interface CheckEvidence {
  id: string;
  criterionId: string;
  stage: 'precondition' | 'criterion';
  status: Status | 'PENDING';
  source: 'measured' | 'ai_reviewed';
  expected: string;
  observed: string;
  target: string;
  evidenceIds?: string[];
}
export interface GuidedCase extends CaseResult {
  startedAt?: number;
  id: string;
  prepared: boolean;
  begun: boolean;
  ended: boolean;
  uncertain: boolean;
  checks: Record<string, CheckEvidence>;
  counters: { calls: number; interactions: number; images: number; recoveries: number; characters: number };
}
export function expectedText(c: Criterion) {
  return 'kind' in c ? c.expectedDescription : String(c.expected);
}
export function caseStatus(c: GuidedCase, definition: Mission['cases'][number]): Status {
  if (Object.values(c.checks).some(v => v.stage === 'criterion' && v.status === 'FAIL')) return 'FAIL';
  if (
    !c.begun ||
    c.uncertain ||
    c.reason ||
    [...definition.preconditions, ...definition.criteria].some(v => c.checks[v.id]?.status !== 'PASS')
  )
    return 'NOT_VERIFIED';
  return 'PASS';
}
export function guidedReport(mission: Mission, cases: GuidedCase[], started: number, environment: string) {
  const resolved = cases.map((c, i) => ({ ...c, status: caseStatus(c, mission.cases[i]) }));
  const status = aggregateStatus(resolved.map(c => c.status));
  const markdown =
    renderReport({
      requirement: mission.requirement,
      buildReference: mission.buildReference,
      company: mission.company,
      environment,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      status,
      cases: resolved,
    }) +
    "\nEvidence sources: MEASURED checks use observed values; AI_REVIEWED judgements are supplied by the calling AI and are not independently proven by the server. Target binding to the requirement is the calling AI's choice.\n" +
    resolved
      .map(
        c =>
          `\n${safeText(c.id)}: calls=${c.counters.calls}, interactions=${c.counters.interactions}, images=${c.counters.images}, responseCharacters=${c.counters.characters}, recoveriesWithoutProgress=${c.counters.recoveries}\n` +
          Object.values(c.checks)
            .map(
              v =>
                `${safeText(v.id)}: ${v.source.toUpperCase()} / ${v.status}; evidence=${safeText(v.evidenceIds?.join(',') ?? v.id)}`,
            )
            .join('\n'),
      )
      .join('');
  const summarize = (limit: number, includeEvidenceIds: boolean) =>
    resolved.map((c, caseIndex) => {
      const definition = mission.cases[caseIndex];
      const declared = [...definition.preconditions, ...definition.criteria];
      return {
        caseIndex: caseIndex + 1,
        id: c.id.slice(0, limit),
        name: c.name.slice(0, limit),
        status: c.status,
        reason: c.reason?.slice(0, limit),
        counters: c.counters,
        // Stable mission indexes keep all outcomes identifiable even when long IDs
        // must be abbreviated. The complete IDs and evidence remain in local files.
        checks: declared.map((criterion, criterionIndex) => {
          const evidence = c.checks[criterion.id];
          return {
            criterionIndex: criterionIndex + 1,
            criterionId: criterion.id.slice(0, limit),
            stage: criterionIndex < definition.preconditions.length ? 'precondition' : 'criterion',
            status: evidence?.status ?? 'NOT_VERIFIED',
            source: evidence?.source,
            evidenceId: includeEvidenceIds ? evidence?.id : undefined,
          };
        }),
        journeyTotal: c.steps.length,
        journey: c.steps
          .slice(-5)
          .map(step => ({
            action: step.label.slice(0, Math.min(limit, 60)),
            completed: step.completed,
            observed: step.observed.slice(0, Math.min(limit, 60)),
          })),
        abbreviated: true,
      };
    });
  let limit = 96;
  let includeEvidenceIds = true;
  let summary = summarize(limit, includeEvidenceIds);
  // Reserve room for the manager's phase and two local report paths in an ~18k
  // finish response; bound serialized characters, including escaped input text.
  while (JSON.stringify({ status, cases: summary }).length > 15000 && (limit > 0 || includeEvidenceIds)) {
    if (limit <= 12 && includeEvidenceIds) includeEvidenceIds = false;
    else limit = Math.floor(limit / 2);
    summary = summarize(limit, includeEvidenceIds);
  }
  return { status, markdown, cases: summary };
}
