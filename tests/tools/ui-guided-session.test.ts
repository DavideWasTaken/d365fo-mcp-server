import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir as readdirOf, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GuidedSessionManager } from '../../src/tools/sdlc/uiVerification/guided/sessionManager.js';
import { exampleMission } from '../../src/tools/sdlc/uiVerification/guided/contract.js';
import { GuidedJournal } from '../../src/tools/sdlc/uiVerification/guided/journal.js';
import { UiDiagnosticError } from '../../src/tools/sdlc/uiVerification/diagnostics.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(options: { limits?: Record<string, number> } = {}, aiReview = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'guided-manager-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let clicks = 0;
  let serial = 0;
  const handle = {
    getAttribute: async () => null,
    isEnabled: async () => true,
    isVisible: async () => true,
    innerText: async () => 'Saved',
    inputValue: async () => '5',
    click: async (o?: any) => {
      if (!o?.trial) clicks++;
    },
    evaluate: async () => false,
  };
  const browser = {
    profile: { outputDir: dir, baseUrl: 'http://localhost', storageState: path.join(dir, 'auth.json') },
    page: { frames: () => [] },
    observe: async () => ({
      snapshotId: `s${++serial}`,
      phase: 'DISCOVERING',
      url: 'http://localhost/',
      nodes: [{ ref: 'e1', role: 'button', name: 'Save' }],
      truncated: false,
      capturedAt: new Date().toISOString(),
    }),
    resolve: async (snapshot: string) => {
      if (snapshot !== `s${serial}`) throw Object.assign(new Error('Stale observation'), { code: 'NEEDS_OBSERVATION' });
      return handle;
    },
    prepareCase: async () => {},
    bindCompany: async () => {},
    checkCompany: async () => {},
    inspectSystemErrors: async () => ({ complete: true, errors: [] as any[] }),
    close: async () => {},
  };
  const manager = new GuidedSessionManager({ openBrowser: async () => browser as any });
  cleanup.push(() => manager.dispose());
  const mission = structuredClone(exampleMission);
  mission.cases = [mission.cases[0]];
  mission.cases[0].criteria = [
    { id: 'result', targetDescription: 'Result', check: 'text', match: 'exact', expected: 'Saved' },
  ];
  if (aiReview)
    mission.cases[0].criteria = [
      {
        id: 'result',
        targetDescription: 'Visible result',
        kind: 'ai_review',
        expectedDescription: 'The result agrees with the requirement',
      },
    ];
  const start = await manager.call({ action: 'start', mission, ...options });
  const sessionId = start.payload.sessionId;
  return { manager, sessionId, mission, browser, handle, clicks: () => clicks, dir };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const base = { sessionId: f.sessionId, caseId: 'positive' };
  const prepared = await f.manager.call({ action: 'case', operation: 'prepare', ...base });
  const snapshotId = prepared.payload.observation.snapshotId;
  await f.manager.call({ action: 'case', operation: 'begin', ...base, snapshotId, companyRef: 'e1' });
  await f.manager.call({
    action: 'check',
    ...base,
    stage: 'precondition',
    criterionId: 'ready',
    snapshotId,
    ref: 'e1',
  });
  return { ...base, snapshotId };
}
describe('guided session workflow', () => {
  it('detects a platform error on a repeated immutable check without replacing its PASS', async () => {
    const f = await fixture();
    const base = await ready(f);
    const acted = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'open',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    const check = {
      action: 'check',
      ...base,
      snapshotId: acted.payload.observation.snapshotId,
      criterionId: 'result',
      ref: 'e1',
    };
    expect((await f.manager.call(check)).payload.check.status).toBe('PASS');
    f.browser.inspectSystemErrors = async () => ({
      complete: true,
      errors: [{ code: 'MENU_ITEM_OPEN_FAILED', message: 'D365 menu failure' }],
    });
    const again = await f.manager.call(check);
    expect(again.payload.historical).toBe(true);
    expect(again.payload.check.status).toBe('PASS');
    expect(again.payload.systemErrors).toHaveLength(1);
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('FAIL');
  });
  it('stops a multi-action batch after the first interaction displays a system error', async () => {
    const f = await fixture();
    const base = await ready(f);
    Object.assign(f.handle, {
      isEditable: async () => true,
      fill: async () => {
        f.browser.inspectSystemErrors = async () => ({
          complete: true,
          errors: [{ code: 'MENU_ITEM_OPEN_FAILED', message: 'D365 menu failure' }],
        });
      },
    });
    const result = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'batch',
      actions: [
        { type: 'fill', ref: 'e1', value: '7' },
        { type: 'click', ref: 'e1' },
      ],
    });
    expect(result.payload.completed).toBe(1);
    expect(result.payload.systemErrors).toHaveLength(1);
    expect(f.clicks()).toBe(0);
  });
  it('keeps WRITE_UNCERTAIN while also recording independent system failure evidence', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.handle.click = async (o?: any) => {
      if (!o?.trial) {
        f.browser.inspectSystemErrors = async () => ({
          complete: true,
          errors: [{ code: 'MENU_ITEM_OPEN_FAILED', message: 'D365 menu failure' }],
        });
        throw new Error('dispatch timeout');
      }
    };
    const result = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'uncertain',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    expect(result.payload.code).toBe('WRITE_UNCERTAIN');
    const observed = await f.manager.call({ action: 'observe', sessionId: f.sessionId });
    expect(observed.payload.phase).toBe('WRITE_UNCERTAIN');
    expect(observed.payload.systemErrors).toHaveLength(1);
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('FAIL');
  });
  it('records a system error despite passing criteria and retains it after dismissal', async () => {
    const f = await fixture();
    const base = await ready(f);
    const error = { code: 'MENU_ITEM_OPEN_FAILED', message: 'Unable to open menu item', source: 'dialog' };
    f.handle.click = async (o?: any) => {
      if (!o?.trial) f.browser.inspectSystemErrors = async () => ({ complete: true, errors: [error] });
    };
    const acted = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'open',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    expect(acted.payload.systemErrors).toHaveLength(1);
    f.browser.inspectSystemErrors = async () => ({ complete: true, errors: [] });
    const observed = await f.manager.call({ action: 'observe', sessionId: f.sessionId });
    const checked = await f.manager.call({
      action: 'check',
      ...base,
      snapshotId: observed.payload.observation.snapshotId,
      criterionId: 'result',
      ref: 'e1',
    });
    expect(checked.payload.check.status).toBe('PASS');
    const result = await f.manager.call({ action: 'finish', sessionId: f.sessionId });
    expect(result.payload.status).toBe('FAIL');
    expect(result.payload.cases[0].systemErrors[0].code).toBe('MENU_ITEM_OPEN_FAILED');
    expect(await readFile(result.payload.reportPath, 'utf8')).toContain('System errors');
  });
  it('blocks dispatch when a system error already exists before the first action', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.browser.inspectSystemErrors = async () => ({
      complete: true,
      errors: [{ code: 'MULTIPLE_SYSTEM_ERRORS', message: 'Più errori ricevuti', source: 'dialog' }],
    });
    const result = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'no-dispatch',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    expect(result.payload.code).toBe('SYSTEM_ERROR_DETECTED');
    expect(f.clicks()).toBe(0);
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('NOT_VERIFIED');
  });
  it('does not return PASS when the final independent error inspection is unavailable', async () => {
    const f = await fixture();
    const base = await ready(f);
    await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' });
    f.browser.inspectSystemErrors = async () => {
      throw new Error('secret browser URL');
    };
    const result = await f.manager.call({ action: 'finish', sessionId: f.sessionId });
    expect(result.payload.status).toBe('NOT_VERIFIED');
    expect(JSON.stringify(result)).not.toContain('secret browser URL');
    expect(result.payload.cases[0].systemErrorInspectionIncomplete).toBeTruthy();
  });
  it('keeps trusted disabled-control guidance instead of a generic browser error', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.handle.isEnabled = async () => false;
    const result = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'disabled',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    expect(result.payload.code).toBe('NEEDS_OBSERVATION');
    expect(result.payload.message).toContain('disabled');
    expect(f.clicks()).toBe(0);
  });
  it('returns a safe structured startup cause including blocked origin but no authentication query', async () => {
    const manager = new GuidedSessionManager({
      openBrowser: async () => {
        throw new UiDiagnosticError({
          phase: 'navigation',
          code: 'NAVIGATION_BLOCKED',
          blockedOrigin: 'https://login.windows.net/tenant?code=private-token',
        });
      },
    });
    try {
      const result = await manager.call({ action: 'start', mission: exampleMission });
      expect(result.payload.diagnostic).toMatchObject({
        phase: 'navigation',
        code: 'NAVIGATION_BLOCKED',
        blockedOrigin: 'https://login.windows.net',
      });
      expect(JSON.stringify(result)).not.toContain('private-token');
      expect(result.payload.message).toContain('login.windows.net');
    } finally {
      await manager.dispose();
    }
  });
  it('allows rebinding an incompatible text criterion to actual text without changing the mission', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.handle.evaluate = async (_fn: any, ...args: any[]) =>
      args.length ? false : ({ nativeValue: true, tag: 'input', checked: false } as any);
    expect((await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' })).payload.code).toBe(
      'CHECK_NOT_APPLICABLE',
    );
    f.handle.evaluate = async () => false;
    const result = await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' });
    expect(result.payload.check.status).toBe('PASS');
    expect(result.payload.counters.recoveries).toBe(0);
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('PASS');
  });
  it('reports an incompatible criterion as NOT_VERIFIED without creating a terminal functional FAIL', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.handle.evaluate = async (_fn: any, ...args: any[]) =>
      args.length ? false : ({ nativeValue: true, tag: 'input', checked: false } as any);
    const result = await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' });
    expect(result.payload.status).toBe('NOT_VERIFIED');
    expect(result.payload.code).toBe('CHECK_NOT_APPLICABLE');
    const finished = await f.manager.call({ action: 'finish', sessionId: f.sessionId });
    expect(finished.payload.status).toBe('NOT_VERIFIED');
    expect(await readFile(finished.payload.reportPath, 'utf8')).toContain('value');
  });
  it('can retrieve an existing receipt even when report persistence is unavailable', async () => {
    const f = await fixture();
    const base = await ready(f);
    const persistence = vi
      .spyOn(GuidedJournal.prototype, 'saveReport')
      .mockRejectedValue(new Error('Disk unavailable'));
    try {
      const action = {
        action: 'act',
        ...base,
        operationId: 'saved-before-error',
        actions: [{ type: 'click', ref: 'e1' }],
      };
      expect((await f.manager.call(action)).payload.code).toBe('NOT_VERIFIED');
      const receipt = await f.manager.call(action);
      expect(receipt.payload.historical).toBe(true);
      expect(receipt.payload.completed).toBe(1);
      expect(f.clicks()).toBe(1);
    } finally {
      persistence.mockRestore();
    }
  });
  it('labels AI judgements and rejects evidence from before the latest interaction', async () => {
    const f = await fixture({}, true);
    const base = await ready(f);
    const review = { passed: true, reason: 'The captured result matches', evidenceIds: [base.snapshotId] };
    expect(
      (await f.manager.call({ action: 'check', ...base, criterionId: 'result', review })).payload.check.source,
    ).toBe('ai_reviewed');
    const acted = await f.manager.call({
      action: 'act',
      ...base,
      operationId: 'change-result',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    expect((await f.manager.call({ action: 'check', ...base, criterionId: 'result', review })).payload.code).toBe(
      'INVALID_STATE',
    );
    expect(
      (
        await f.manager.call({
          action: 'check',
          ...base,
          criterionId: 'result',
          review: { ...review, evidenceIds: [acted.payload.evidenceId] },
        })
      ).payload.check.status,
    ).toBe('PASS');
  });
  it('aborts an in-flight browser start when the server shuts down', async () => {
    let opened!: () => void;
    const opening = new Promise<void>(r => {
      opened = r;
    });
    const manager = new GuidedSessionManager({
      openBrowser: async (_profile, _url, options) => {
        opened();
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('Start aborted')), { once: true }),
        );
        throw new Error('Must not create a browser after disposal');
      },
    });
    const pending = manager.call({ action: 'start', mission: exampleMission });
    await opening;
    await manager.dispose();
    expect((await pending).payload.status).toBe('NOT_VERIFIED');
    expect((await manager.call({ action: 'start', mission: exampleMission })).payload.code).toBe('CLOSED');
  });
  it('retains completed write receipts after post-action observation failure ends the case', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.browser.observe = async () => {
      throw new Error('Observation unavailable');
    };
    const action = { action: 'act', ...base, operationId: 'completed', actions: [{ type: 'click', ref: 'e1' }] };
    expect((await f.manager.call(action)).payload.code).toBe('NOT_VERIFIED');
    const receipt = await f.manager.call(action);
    expect(receipt.payload.historical).toBe(true);
    expect(receipt.payload.completed).toBe(1);
    expect(f.clicks()).toBe(1);
  });
  it('gates actions on preconditions, deduplicates write receipts and completes an evidenced report', async () => {
    const f = await fixture();
    const { manager, sessionId } = f;
    const base = { sessionId, caseId: 'positive' };
    const prepared = await manager.call({ action: 'case', operation: 'prepare', ...base });
    await manager.call({
      action: 'case',
      operation: 'begin',
      ...base,
      snapshotId: prepared.payload.observation.snapshotId,
      companyRef: 'e1',
    });
    const act = {
      action: 'act',
      ...base,
      snapshotId: prepared.payload.observation.snapshotId,
      operationId: 'save-1',
      actions: [{ type: 'click', ref: 'e1' }],
    };
    expect((await manager.call(act)).payload.code).toBe('PRECONDITIONS_REQUIRED');
    expect(f.clicks()).toBe(0);
    await manager.call({
      action: 'check',
      ...base,
      stage: 'precondition',
      criterionId: 'ready',
      snapshotId: act.snapshotId,
      ref: 'e1',
    });
    const first = await manager.call(act);
    expect(f.clicks()).toBe(1);
    const duplicate = await manager.call(act);
    expect(duplicate.payload.historical).toBe(true);
    expect(f.clicks()).toBe(1);
    await manager.call({
      action: 'check',
      ...base,
      criterionId: 'result',
      snapshotId: first.payload.observation.snapshotId,
      ref: 'e1',
    });
    const end = await manager.call({ action: 'finish', sessionId });
    expect(end.payload.status).toBe('PASS');
    expect(await readFile(end.payload.reportPath, 'utf8')).toContain('Saved');
    expect(await readFile(path.join(path.dirname(end.payload.reportPath), 'events.jsonl'), 'utf8')).not.toContain(
      sessionId,
    );
  });
  it('does not accept a fabricated capability or allow PASS with missing criteria', async () => {
    const { manager, sessionId } = await fixture();
    expect((await manager.call({ action: 'observe', sessionId: '0'.repeat(64) })).payload.code).toBe('SESSION_EXPIRED');
    expect((await manager.call({ action: 'finish', sessionId })).payload.status).toBe('NOT_VERIFIED');
  });
  it('invalidates a prior result PASS after another interaction', async () => {
    const f = await fixture();
    const base = await ready(f);
    expect(
      (await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' })).payload.check.status,
    ).toBe('PASS');
    await f.manager.call({ action: 'act', ...base, operationId: 'change', actions: [{ type: 'click', ref: 'e1' }] });
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('NOT_VERIFIED');
  });
  it('keeps a functional FAIL immutable after the displayed result changes', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.handle.innerText = async () => 'Rejected';
    expect(
      (await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' })).payload.check.status,
    ).toBe('FAIL');
    f.handle.innerText = async () => 'Saved';
    expect(
      (await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' })).payload.check.status,
    ).toBe('FAIL');
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('FAIL');
  });
  it('never retries an interaction whose outcome is uncertain, even with a new operation ID', async () => {
    const f = await fixture();
    const base = await ready(f);
    let writes = 0;
    f.handle.click = async o => {
      if (!o?.trial) {
        writes++;
        throw new Error('Response lost after write');
      }
    };
    const input = { action: 'act', ...base, operationId: 'save', actions: [{ type: 'click', ref: 'e1' }] };
    expect((await f.manager.call(input)).payload.code).toBe('WRITE_UNCERTAIN');
    expect((await f.manager.call(input)).payload.historical).toBe(true);
    expect((await f.manager.call({ ...input, operationId: 'retry' })).payload.code).toBe('WRITE_UNCERTAIN');
    expect(writes).toBe(1);
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.status).toBe('NOT_VERIFIED');
  });
  it('requests observation for stale targets without dispatching an interaction', async () => {
    const f = await fixture();
    const base = await ready(f);
    await f.manager.call({ action: 'observe', sessionId: f.sessionId });
    expect(
      (await f.manager.call({ action: 'act', ...base, operationId: 'stale', actions: [{ type: 'click', ref: 'e1' }] }))
        .payload.code,
    ).toBe('NEEDS_OBSERVATION');
    expect(f.clicks()).toBe(0);
  });
  // A full page load detaches the bound company element while the page still
  // shows the company. begin used to return early once the case had begun, so
  // the binding could never be re-confirmed and every check stayed NOT_VERIFIED.
  describe('company binding lost to a full page load', () => {
    async function withBinding() {
      const f = await fixture();
      let bound = false;
      const binds: string[] = [];
      f.browser.bindCompany = async (_snapshot: string, _ref: string, company: string) => {
        binds.push(company);
        bound = true;
      };
      f.browser.checkCompany = async () => {
        // What browserSession.checkCompany reports for a detached element.
        if (!bound) throw Object.assign(new Error('The bound company control is gone'), { code: 'NEEDS_OBSERVATION' });
      };
      const base = await ready(f);
      return { f, base, binds, detach: () => { bound = false; } };
    }

    it('re-confirms the same company on a new observation and keeps the case going', async () => {
      const { f, base, binds, detach } = await withBinding();
      detach();
      const lost = await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' });
      // Recoverable: the case is not ended, so begin can re-confirm.
      expect(lost.payload.code).toBe('NEEDS_OBSERVATION');

      const observed = await f.manager.call({ action: 'observe', sessionId: f.sessionId });
      const again = await f.manager.call({
        action: 'case', operation: 'begin', ...base, snapshotId: observed.payload.observation.snapshotId, companyRef: 'e1',
      });
      expect(again.payload.companyReconfirmed).toBe(true);
      expect(binds).toEqual([f.mission.company, f.mission.company]);

      const acted = await f.manager.call({
        action: 'act', ...base, snapshotId: observed.payload.observation.snapshotId, operationId: 'open',
        actions: [{ type: 'click', ref: 'e1' }],
      });
      const check = await f.manager.call({
        action: 'check', ...base, snapshotId: acted.payload.observation.snapshotId, criterionId: 'result', ref: 'e1',
      });
      expect(check.payload.check.status).toBe('PASS');
      const run = (await readdirOf(f.dir)).find(n => n.startsWith('guided-'))!;
      expect(await readFile(path.join(f.dir, run, 'events.jsonl'), 'utf8')).toContain('company_reconfirmed');
    });

    it('leaves an intact binding alone on a repeated begin', async () => {
      const { f, base, binds } = await withBinding();
      const again = await f.manager.call({ action: 'case', operation: 'begin', ...base, snapshotId: base.snapshotId, companyRef: 'e1' });
      expect(again.payload.companyReconfirmed).toBeUndefined();
      expect(binds).toHaveLength(1);
    });

    it('does not re-confirm when the page no longer shows the company', async () => {
      const { f, base, detach } = await withBinding();
      detach();
      f.browser.bindCompany = async () => {
        throw Object.assign(new Error('The observed company does not match the requested company exactly'), { code: 'NOT_VERIFIED' });
      };
      const observed = await f.manager.call({ action: 'observe', sessionId: f.sessionId });
      const again = await f.manager.call({
        action: 'case', operation: 'begin', ...base, snapshotId: observed.payload.observation.snapshotId, companyRef: 'e1',
      });
      expect(again.payload.code).toBe('NOT_VERIFIED');
      expect(again.payload.companyReconfirmed).toBeUndefined();
    });
  });
  it('allows finish after a call budget is exhausted', async () => {
    const f = await fixture({ limits: { calls: 1 } });
    const base = { sessionId: f.sessionId, caseId: 'positive' };
    await f.manager.call({ action: 'case', operation: 'prepare', ...base });
    expect((await f.manager.call({ action: 'observe', sessionId: f.sessionId })).payload.code).toBe('BUDGET_EXCEEDED');
    expect((await f.manager.call({ action: 'finish', sessionId: f.sessionId })).payload.phase).toBe('CLOSED');
  });
  it('rejects parallel calls and permits capability-authorized finish to interrupt a pending write', async () => {
    const f = await fixture();
    const base = await ready(f);
    let release!: () => void, started!: () => void;
    const dispatched = new Promise<void>(r => {
      started = r;
    });
    const blocked = new Promise<void>(r => {
      release = r;
    });
    (f.browser as any).context = {
      close: async () => {
        release();
      },
    };
    f.handle.click = async o => {
      if (!o?.trial) {
        started();
        await blocked;
      }
    };
    const pending = f.manager.call({
      action: 'act',
      ...base,
      operationId: 'pending',
      actions: [{ type: 'click', ref: 'e1' }],
    });
    await dispatched;
    expect((await f.manager.call({ action: 'observe', sessionId: f.sessionId })).payload.code).toBe('BUSY');
    const finished = await f.manager.call({ action: 'finish', sessionId: f.sessionId });
    expect((await pending).payload.code).toBe('WRITE_UNCERTAIN');
    expect(finished.payload.status).toBe('NOT_VERIFIED');
  });
  it('bounds measured values returned to the AI', async () => {
    const f = await fixture();
    const base = await ready(f);
    f.handle.innerText = async () => 'X'.repeat(100000);
    const result = await f.manager.call({ action: 'check', ...base, criterionId: 'result', ref: 'e1' });
    expect(result.payload.check.observed.length).toBeLessThanOrEqual(2000);
    expect(result.payload.check.status).toBe('FAIL');
  });
});
