import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GuidedInputSchema, LimitsSchema, type GuidedInput, type Mission } from './contract.js';
import { GuidedBrowser } from './browserSession.js';
import { GuidedJournal, recoverInterruptedReports } from './journal.js';
import { caseStatus, expectedText, guidedReport, type GuidedCase, type CheckEvidence } from './report.js';
import { preflightAction, dispatchAction } from './actions.js';
import { measureCheck } from './checks.js';
import { MissingUiEnvironmentUrl } from '../profile.js';

export interface GuidedReply {
  payload: Record<string, any>;
  image?: { data: string; mimeType: string };
}
type Receipt = { hash: string; payload: Record<string, any> };
interface Session {
  browser: GuidedBrowser;
  mission: Mission;
  limits: ReturnType<typeof LimitsSchema.parse>;
  journal: GuidedJournal;
  started: number;
  active?: GuidedCase;
  cases: GuidedCase[];
  phase: string;
  busy?: Promise<void>;
  release?: () => void;
  controller?: AbortController;
  sent: boolean;
  closing: boolean;
  closed?: GuidedReply;
  timer?: ReturnType<typeof setTimeout>;
  receipts: Map<string, Receipt>;
  evidence: Map<string, { caseId?: string; source: string; interactions: number }>;
  bootstrapCalls: number;
  bootstrapImages: number;
  lastActivity: number;
  finishing?: Promise<GuidedReply>;
}
const counters = () => ({ calls: 0, interactions: 0, images: 0, recoveries: 0, characters: 0 });
const fault = (code: string, message: string) => Object.assign(new Error(message), { code });
const shortError = (e: unknown) => (e instanceof Error ? e.message.slice(0, 500) : 'Browser operation failed');
const failed = (code: string, message: string): GuidedReply => ({ payload: { code, message, status: 'NOT_VERIFIED' } });

export class GuidedSessionManager {
  private sessions = new Map<string, Session>();
  private recovered = new Set<string>();
  private starts = 0;
  private pendingStarts = new Set<Promise<GuidedReply>>();
  private startControllers = new Set<AbortController>();
  private disposed = false;
  constructor(private options: { openBrowser?: typeof GuidedBrowser.open; headless?: boolean } = {}) {}

  async call(raw: unknown, signal?: AbortSignal): Promise<GuidedReply> {
    const input = GuidedInputSchema.parse(raw);
    if (this.disposed) return failed('CLOSED', 'Server is shutting down');
    if (input.action === 'start') {
      const pending = this.start(input, signal);
      this.pendingStarts.add(pending);
      try {
        return await pending;
      } finally {
        this.pendingStarts.delete(pending);
      }
    }
    const s = this.sessions.get(input.sessionId);
    if (!s) return failed('SESSION_EXPIRED', 'Session is unavailable; do not replay prior actions');
    if (input.action === 'finish') {
      if (s.closed) return s.closed;
      s.closing = true;
      s.controller?.abort();
      if (s.busy) await s.busy;
      return this.finish(s, input.reason ?? 'Finished by caller');
    }
    if (s.closed || s.closing) return failed('SESSION_EXPIRED', 'Session is closed; inspect its report');
    if (s.busy) return failed('BUSY', 'Another call is running in this session');
    s.busy = new Promise<void>(resolve => {
      s.release = resolve;
    });
    s.lastActivity = Date.now();
    s.sent = false;
    this.arm(s, true);
    const controller = new AbortController();
    s.controller = controller;
    s.browser.setOperation?.(controller.signal, s.limits.callTimeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, s.limits.callTimeoutMs);
    const stopInteraction = () => {
      if (s.sent && s.active) {
        s.active.uncertain = true;
        s.phase = 'WRITE_UNCERTAIN';
      }
      // A dispatched action cannot safely keep running after cancellation.
      if (s.sent) void s.browser.context?.close().catch(() => {});
    };
    controller.signal.addEventListener('abort', stopInteraction, { once: true });
    try {
      this.checkAbort(s);
      const reply = await this.execute(s, input);
      this.checkAbort(s);
      if (s.active) s.active.counters.characters += JSON.stringify(reply.payload).length;
      if (!reply.payload.historical) await this.persist(s);
      return reply;
    } catch (e) {
      const code =
        (e as { code?: string }).code ??
        (s.active?.uncertain ? 'WRITE_UNCERTAIN' : controller.signal.aborted ? 'CANCELLED' : 'NOT_VERIFIED');
      const message = shortError(e);
      if (s.active && code !== 'PRECONDITIONS_REQUIRED' && code !== 'INVALID_STATE' && code !== 'OPERATION_ID_REUSED') {
        if (code === 'NEEDS_OBSERVATION') {
          s.active.counters.recoveries++;
          s.phase = s.active.uncertain ? 'WRITE_UNCERTAIN' : 'NEEDS_OBSERVATION';
          if (s.active.counters.recoveries > s.limits.recoveries) {
            s.active.reason = 'Recovery budget exceeded';
            s.active.ended = true;
          }
        } else if (code === 'BUDGET_EXCEEDED' || code === 'NOT_VERIFIED' || code === 'WRITE_UNCERTAIN') {
          s.active.reason = message;
          if (code !== 'WRITE_UNCERTAIN') s.active.ended = true;
        }
      }
      await s.journal.append('blocked', { code, message }).catch(() => {});
      await this.persist(s).catch(() => {});
      return failed(code, message);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stopInteraction);
      s.browser.setOperation?.();
      s.controller = undefined;
      s.sent = false;
      s.release?.();
      s.release = undefined;
      s.busy = undefined;
      if (!s.closed && !s.closing) this.arm(s);
    }
  }
  private checkAbort(s: Session) {
    if (s.controller?.signal.aborted)
      throw fault(
        s.active?.uncertain ? 'WRITE_UNCERTAIN' : 'CANCELLED',
        'Operation cancelled or deadline exceeded; never replay an uncertain interaction',
      );
  }
  private async start(input: Extract<GuidedInput, { action: 'start' }>, signal?: AbortSignal): Promise<GuidedReply> {
    if (!input.mission.buildReference.ready)
      return failed('BUILD_NOT_READY', 'Declare the deployed build ready before testing');
    if ([...this.sessions.values()].filter(s => !s.closed).length + this.starts >= 2)
      return failed('BUSY', 'Two browser sessions are already active');
    this.starts++;
    let browser: GuidedBrowser | undefined;
    let token: string | undefined;
    const controller = new AbortController();
    this.startControllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, Math.min(input.limits?.callTimeoutMs ?? 30000, 45000));
    try {
      if (controller.signal.aborted || this.disposed) throw new Error('Start cancelled');
      browser = await (this.options.openBrowser ?? GuidedBrowser.open)(input.profilePath, input.environmentUrl, {
        headless: this.options.headless,
        signal: controller.signal,
        timeoutMs: input.limits?.callTimeoutMs,
        startUrl: input.mission.startUrl,
      });
      if (controller.signal.aborted || this.disposed) throw new Error('Start cancelled');
      if (!this.recovered.has(browser.profile.outputDir)) {
        this.recovered.add(browser.profile.outputDir);
        await recoverInterruptedReports(browser.profile.outputDir);
      }
      const journal = await GuidedJournal.create(browser.profile.outputDir, input.mission);
      const s: Session = {
        browser,
        mission: input.mission,
        journal,
        limits: LimitsSchema.parse(input.limits ?? {}),
        started: Date.now(),
        lastActivity: Date.now(),
        phase: 'DISCOVERING',
        cases: input.mission.cases.map(c => ({
          id: c.id,
          name: c.goal,
          status: 'NOT_VERIFIED',
          durationMs: 0,
          steps: [],
          checks: Object.create(null),
          prepared: false,
          begun: false,
          ended: false,
          uncertain: false,
          counters: counters(),
        })),
        receipts: new Map(),
        evidence: new Map(),
        bootstrapCalls: 0,
        bootstrapImages: 0,
        sent: false,
        closing: false,
      };
      token = randomBytes(32).toString('hex');
      this.sessions.set(token, s);
      const reply = await this.observe(s, {});
      if (controller.signal.aborted || this.disposed) throw new Error('Start cancelled');
      await this.persist(s);
      this.arm(s);
      return { ...reply, payload: { sessionId: token, ...reply.payload, limits: s.limits } };
    } catch (e) {
      await browser?.close().catch(() => {});
      if (token) this.sessions.delete(token);
      if (e instanceof MissingUiEnvironmentUrl) throw e;
      return failed('NOT_VERIFIED', 'Unable to start guided browser: ' + shortError(e));
    } finally {
      this.starts--;
      this.startControllers.delete(controller);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  private arm(s: Session, busy = false) {
    if (s.timer) clearTimeout(s.timer);
    const remaining = Math.min(busy ? Infinity : s.limits.idleTimeoutMs, s.started + s.limits.lifetimeMs - Date.now());
    s.timer = setTimeout(
      () => {
        s.closing = true;
        s.controller?.abort();
        void (async () => {
          if (s.busy) await s.busy;
          await this.finish(s, 'Session expired');
        })().catch(() => {});
      },
      Math.max(1, remaining),
    );
    s.timer.unref();
  }
  private charge(s: Session, kind: 'calls' | 'interactions' | 'images') {
    if (!s.active) {
      if (kind === 'images') {
        if (s.bootstrapImages >= s.limits.images) throw fault('BUDGET_EXCEEDED', 'Discovery image budget exceeded');
        s.bootstrapImages++;
      } else if (++s.bootstrapCalls > 30) throw fault('BUDGET_EXCEEDED', 'Discovery call budget exceeded');
      return;
    }
    if (s.active.counters[kind] >= s.limits[kind]) throw fault('BUDGET_EXCEEDED', `${kind} budget exceeded`);
    s.active.counters[kind]++;
  }
  private active(s: Session, caseId: string) {
    if (!s.active || s.active.id !== caseId || s.active.ended)
      throw fault('INVALID_STATE', 'Prepare the requested case; do not reuse another case context');
    return s.active;
  }
  private async observe(
    s: Session,
    options: { scopeRef?: string; filter?: string; screenshot?: boolean },
    charge = true,
  ): Promise<GuidedReply> {
    if (charge) this.charge(s, 'calls');
    if (options.screenshot) this.charge(s, 'images');
    const observation = await s.browser.observe(options);
    if (observation.phase === 'AUTH_REQUIRED') {
      s.phase = 'AUTH_REQUIRED';
      if (s.active?.begun) {
        s.active.reason = 'Login expired during case; authenticate separately, never replay';
        s.active.ended = true;
      }
      return {
        payload: {
          phase: 'AUTH_REQUIRED',
          message: 'Complete login/MFA manually in the dedicated browser, then observe again',
        },
      };
    }
    if (s.phase === 'AUTH_REQUIRED') s.phase = 'DISCOVERING';
    const { image, ...data } = observation;
    s.evidence.set(data.snapshotId, {
      caseId: s.active?.id,
      source: 'observation',
      interactions: s.active?.counters.interactions ?? 0,
    });
    await writeFile(path.join(s.journal.directory, `${data.snapshotId}.json`), JSON.stringify(data), { mode: 0o600 });
    if (image)
      await writeFile(
        path.join(s.journal.directory, `${data.snapshotId}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`),
        Buffer.from(image.data, 'base64'),
        { mode: 0o600 },
      );
    const payload = { phase: s.phase, observation: data, evidenceId: data.snapshotId, counters: s.active?.counters };
    return { payload, image };
  }
  private async execute(s: Session, input: Exclude<GuidedInput, { action: 'start' | 'finish' }>): Promise<GuidedReply> {
    if (input.action === 'observe') return this.observe(s, input);
    if (input.action === 'case') {
      const c = s.cases.find(c => c.id === input.caseId);
      if (!c) throw fault('INVALID_STATE', 'Unknown case');
      if (input.operation === 'prepare') {
        if (c.ended || (s.active && s.active !== c && !s.active.ended))
          throw fault(
            'INVALID_STATE',
            'End the current case before preparing a new one; completed cases cannot restart',
          );
        s.active = c;
        if (!c.prepared) {
          await s.browser.prepareCase(c.id);
          this.checkAbort(s);
          c.prepared = true;
          c.startedAt = Date.now();
          s.phase = 'DISCOVERING';
        }
        return this.observe(s, {});
      }
      this.active(s, input.caseId);
      if (input.operation === 'begin') {
        if (c.begun) return { payload: { phase: s.phase, caseId: c.id } };
        await s.browser.bindCompany(input.snapshotId!, input.companyRef!, s.mission.company);
        this.checkAbort(s);
        c.begun = true;
        s.phase = 'PRECONDITIONS';
        await s.journal.append('case_begun', { caseId: c.id });
        return {
          payload: {
            phase: s.phase,
            preconditionIds: s.mission.cases.find(v => v.id === c.id)!.preconditions.map(v => v.id),
          },
        };
      }
      c.ended = true;
      c.durationMs = c.startedAt ? Date.now() - c.startedAt : 0;
      c.status = caseStatus(c, s.mission.cases.find(v => v.id === c.id)!);
      s.phase = 'READY';
      await s.journal.append('case_ended', { caseId: c.id, status: c.status });
      return { payload: { caseId: c.id, status: c.status, phase: s.phase } };
    }
    if (input.action === 'act') {
      const old = s.receipts.get(`${input.caseId}:${input.operationId}`);
      if (old) {
        const hash = createHash('sha256')
          .update(JSON.stringify({ ...input, sessionId: undefined }))
          .digest('hex');
        if (old.hash !== hash) throw fault('OPERATION_ID_REUSED', 'Operation ID was already used with different input');
        return { payload: { ...old.payload, historical: true, requiresObservation: true } };
      }
    }
    const c = this.active(s, input.caseId);
    if (input.action === 'act') return this.act(s, c, input);
    this.charge(s, 'calls');
    if (!c.begun) throw fault('PRECONDITIONS_REQUIRED', 'Confirm company with case begin first');
    if (!c.uncertain) await s.browser.checkCompany();
    const definition = s.mission.cases.find(v => v.id === c.id)!;
    const criterion = (input.stage === 'precondition' ? definition.preconditions : definition.criteria).find(
      v => v.id === input.criterionId,
    );
    if (!criterion) throw fault('INVALID_STATE', 'Criterion ID is not in the immutable mission');
    const old = c.checks[criterion.id];
    if (old && old.status !== 'PENDING') return { payload: { phase: s.phase, check: old, historical: true } };
    if (input.stage === 'precondition' && c.counters.interactions)
      throw fault('INVALID_STATE', 'Preconditions cannot be established after application actions');
    if (input.stage === 'criterion' && definition.preconditions.some(v => c.checks[v.id]?.status !== 'PASS'))
      throw fault('PRECONDITIONS_REQUIRED', 'Verify all preconditions first');
    let passed: boolean, observed: string, target: string, source: CheckEvidence['source'];
    if ('kind' in criterion) {
      if (
        !input.review ||
        input.review.evidenceIds.some(
          id => s.evidence.get(id)?.caseId !== c.id || s.evidence.get(id)?.interactions !== c.counters.interactions,
        )
      )
        throw fault('INVALID_STATE', 'AI review requires evidence from this case after its latest interaction');
      passed = input.review.passed;
      observed = input.review.reason;
      target = criterion.targetDescription;
      source = 'ai_reviewed';
    } else {
      if (input.review) throw fault('INVALID_STATE', 'A measured criterion cannot become an AI review');
      let result;
      try {
        result = await measureCheck(s.browser.page, (a, b) => s.browser.resolve(a, b), criterion, input);
      } catch (e) {
        throw fault('NEEDS_OBSERVATION', shortError(e));
      }
      passed = result.passed;
      const value = String(result.actual);
      observed = value.length > 2000 ? value.slice(0, 1980) + ' [truncated]' : value;
      target = result.target;
      source = 'measured';
    }
    this.checkAbort(s);
    const status = passed
      ? 'PASS'
      : !input.final
        ? 'PENDING'
        : input.stage === 'precondition'
          ? 'NOT_VERIFIED'
          : 'FAIL';
    const evidence: CheckEvidence = {
      id: `check-${randomUUID()}`,
      criterionId: criterion.id,
      stage: input.stage,
      status,
      source,
      expected: expectedText(criterion),
      observed,
      target,
      evidenceIds: input.review?.evidenceIds,
    };
    await s.journal.append('check', { caseId: c.id, ...evidence });
    c.checks[criterion.id] = evidence;
    c.steps.push({
      label: `${source.toUpperCase()} ${criterion.id}: ${criterion.targetDescription} (${target})`,
      expected: expectedText(criterion),
      observed,
      completed: status === 'PASS',
    });
    if (passed) c.counters.recoveries = 0;
    if (status === 'NOT_VERIFIED') {
      c.reason = 'Initial precondition was not met';
      c.ended = true;
    }
    if (!c.uncertain && definition.preconditions.every(v => c.checks[v.id]?.status === 'PASS')) s.phase = 'CASE_ACTIVE';
    return { payload: { phase: s.phase, check: evidence, counters: c.counters } };
  }
  private async act(s: Session, c: GuidedCase, input: Extract<GuidedInput, { action: 'act' }>): Promise<GuidedReply> {
    const hash = createHash('sha256')
      .update(JSON.stringify({ ...input, sessionId: undefined }))
      .digest('hex');
    const key = `${c.id}:${input.operationId}`;
    if (c.uncertain)
      throw fault(
        'WRITE_UNCERTAIN',
        'Prior interaction outcome is uncertain; only observe/check/end/finish are allowed',
      );
    const definition = s.mission.cases.find(v => v.id === c.id)!;
    if (!c.begun || definition.preconditions.some(v => c.checks[v.id]?.status !== 'PASS'))
      throw fault('PRECONDITIONS_REQUIRED', 'Verify company and all preconditions before interacting');
    this.charge(s, 'calls');
    const receipt: Receipt = { hash, payload: { operationId: input.operationId, completed: 0, phase: 'CASE_ACTIVE' } };
    s.receipts.set(key, receipt);
    for (const action of input.actions) {
      this.checkAbort(s);
      let element;
      try {
        await s.browser.checkCompany();
        element = 'ref' in action ? await s.browser.resolve(input.snapshotId, action.ref) : undefined;
        await preflightAction(s.browser.page, element, action, s.browser.profile.baseUrl);
      } catch (e) {
        receipt.payload = { ...receipt.payload, code: 'NEEDS_OBSERVATION', message: shortError(e) };
        throw fault('NEEDS_OBSERVATION', shortError(e));
      }
      this.checkAbort(s);
      this.charge(s, 'interactions');
      await s.journal.append('action_attempt', {
        caseId: c.id,
        operationId: input.operationId,
        type: action.type,
        target: 'ref' in action ? action.ref : 'navigation',
      });
      // Preconditions describe the initial state; result checks must follow the latest interaction.
      for (const check of Object.values(c.checks))
        if (check.stage === 'criterion' && check.status === 'PASS') delete c.checks[check.criterionId];
      this.checkAbort(s);
      s.sent = true;
      try {
        await dispatchAction(s.browser.page, element, action, s.browser.profile.baseUrl, s.limits.callTimeoutMs);
        this.checkAbort(s);
        await s.journal.append('action_completed', { caseId: c.id, operationId: input.operationId, type: action.type });
        s.sent = false;
        receipt.payload.completed++;
        c.counters.recoveries = 0;
        c.steps.push({
          label: `${action.type}${'ref' in action ? ' ' + action.ref : ''}`,
          expected: 'Execute once',
          observed: 'Interaction completed; business result requires a check',
          completed: true,
        });
      } catch (e) {
        c.uncertain = true;
        s.phase = 'WRITE_UNCERTAIN';
        receipt.payload = {
          ...receipt.payload,
          code: 'WRITE_UNCERTAIN',
          phase: s.phase,
          message: 'Interaction may have reached the server; never replay',
        };
        c.steps.push({ label: action.type, expected: 'Execute once', observed: 'Outcome uncertain', completed: false });
        throw fault('WRITE_UNCERTAIN', shortError(e));
      }
      if (action.type !== 'fill' && action.type !== 'wait') break;
    }
    s.phase = 'CASE_ACTIVE';
    receipt.payload.phase = s.phase;
    // A failed post-action observation must not erase the successful write receipt.
    const observed = await this.observe(s, {}, false);
    return { ...observed, payload: { ...observed.payload, ...receipt.payload } };
  }
  private async persist(s: Session, closed = false) {
    for (const c of s.cases) if (c.startedAt && !c.ended) c.durationMs = Date.now() - c.startedAt;
    const report = guidedReport(s.mission, s.cases, s.started, new URL(s.browser.profile.baseUrl).origin);
    await s.journal.saveReport(report.markdown, report.status, closed);
    return report;
  }
  private finish(s: Session, reason: string): Promise<GuidedReply> {
    return (s.finishing ??= this.finishSession(s, reason));
  }
  private async finishSession(s: Session, reason: string): Promise<GuidedReply> {
    if (s.closed) return s.closed;
    s.closing = true;
    if (s.timer) clearTimeout(s.timer);
    try {
      for (const c of s.cases)
        if (!c.ended) {
          if (caseStatus(c, s.mission.cases.find(v => v.id === c.id)!) !== 'PASS') c.reason ??= reason;
          c.ended = true;
          c.durationMs = c.startedAt ? Date.now() - c.startedAt : 0;
        }
      await s.journal.append('finished', { reason });
      const report = await this.persist(s, true);
      s.closed = {
        payload: {
          phase: 'CLOSED',
          status: report.status,
          cases: report.cases,
          reportPath: path.join(s.journal.directory, 'report.md'),
          missionPath: path.join(s.journal.directory, 'mission.json'),
        },
      };
      return s.closed;
    } finally {
      s.phase = 'CLOSED';
      await s.browser.close().catch(() => {});
      s.evidence.clear();
      s.receipts.clear();
      // Keep a bounded short receipt window for a lost finish response, never retain browsers indefinitely.
      if (!s.closed) s.closed = failed('REPORT_WRITE_FAILED', 'Browser closed; report persistence failed');
      for (const [token, session] of this.sessions)
        if (session === s) {
          s.timer = setTimeout(() => this.sessions.delete(token), 600000);
          s.timer.unref();
        }
      const closed = [...this.sessions].filter(([, session]) => session.closed);
      for (const [token, session] of closed.slice(0, Math.max(0, closed.length - 20))) {
        if (session.timer) clearTimeout(session.timer);
        this.sessions.delete(token);
      }
    }
  }
  async dispose() {
    this.disposed = true;
    for (const controller of this.startControllers) controller.abort();
    await Promise.allSettled([...this.pendingStarts]);
    await Promise.allSettled(
      [...this.sessions.values()].map(async s => {
        s.closing = true;
        s.controller?.abort();
        if (s.busy) await s.busy;
        await this.finish(s, 'Server shutdown');
      }),
    );
    for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer);
    this.sessions.clear();
  }
}
