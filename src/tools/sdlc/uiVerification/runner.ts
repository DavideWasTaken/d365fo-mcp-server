import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { PlanSchema, type Plan, type Assertion, type Step } from './contract.js';
import { allowedNavigationUrl, installNavigationGuard } from './navigation.js';
import { uniqueVisible, visibleMatches } from './locators.js';
import { resolveUiProfile } from './profile.js';
import { assertCheckApplicable } from './checkApplicability.js';
import { launchUiBrowser } from './browserLaunch.js';
import { inspectSystemErrors, retainSystemErrors } from './systemErrors.js';
import { aggregateStatus, renderReport, type CaseResult, type VerificationReport, type StepResult } from './report.js';

export interface RunOptions {
  environmentUrl?: string;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  caseTimeoutMs?: number;
  navigationTimeoutMs?: number;
  timeouts?: { stepTimeoutMs?: number; navigationTimeoutMs?: number; caseTimeoutMs?: number };
}
export interface RunResult extends VerificationReport {
  reportPath: string;
  planPath: string;
}
class FunctionalMismatch extends Error {}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000);
function allowedUrl(raw: string, base: string): string {
  return allowedNavigationUrl(raw, [new URL(base).origin], base);
}
async function observe(page: Page, a: Assertion, scope?: string): Promise<string | boolean> {
  if (a.check === 'visible') {
    const count = await (await visibleMatches(page, a.selector, scope)).count();
    if (count > 1) throw new Error(`Selector must match at most one visible element; observed ${count}: ${a.selector}`);
    return count === 1;
  }
  const l = await uniqueVisible(page, a.selector, scope);
  await assertCheckApplicable(l, a.check);
  switch (a.check) {
    case 'enabled':
      return l.isEnabled();
    case 'text':
      return (await l.innerText()).trim();
    case 'value':
      return l.inputValue();
  }
}
async function assertCheck(
  page: Page,
  a: Assertion,
  functional: boolean,
  evidence: StepResult,
  deadline: number,
  scope?: string,
): Promise<void> {
  // Read-only observations can be abandoned safely at the deadline. A separate
  // context-closing step timer would race this verdict and turn FAIL into NOT_VERIFIED.
  let actual: string | boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        expired = true;
        const detail =
          actual === undefined
            ? 'Assertion selector was not ready before the deadline'
            : `Expected ${String(a.expected)}; observed ${String(actual)}`;
        reject(
          functional && actual !== undefined
            ? new FunctionalMismatch(detail)
            : new Error(`Precondition or assertion unavailable: ${detail}`),
        );
      },
      Math.max(1, deadline - Date.now()),
    );
  });
  try {
    await Promise.race([
      budget,
      (async () => {
        while (!expired) {
          actual = await observe(page, a, scope);
          if (expired) return;
          evidence.observed = String(actual).slice(0, 2000);
          if (
            a.check === 'text' && a.match === 'contains' ? String(actual).includes(a.expected) : actual === a.expected
          )
            return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      })(),
    ]);
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
  }
}

async function execute(
  page: Page,
  s: Step,
  base: string,
  evidence: StepResult,
  deadline: number,
  scope?: string,
  dispatching: () => void = () => {},
): Promise<void> {
  if (s.action === 'navigate') {
    dispatching();
    await page.goto(allowedUrl(s.url, base), { waitUntil: 'domcontentloaded' });
    evidence.observed = 'Navigation completed';
    return;
  }
  if (s.action === 'assert') {
    await assertCheck(page, s, true, evidence, deadline, scope);
    return;
  }
  const l = await uniqueVisible(page, s.selector, scope);
  if (s.action !== 'wait') dispatching();
  switch (s.action) {
    case 'click':
      await l.click();
      break;
    case 'fill':
      await l.fill(s.value);
      break;
    case 'select':
      await l.selectOption(s.value);
      break;
    case 'press':
      await l.press(s.key);
      break;
    case 'wait':
      await l.waitFor({ state: 'visible' });
      break;
  }
  evidence.observed = 'Action completed';
}

/** Public budgets are bounded by contract; internal overrides may only lower them. */
export async function runVerification(
  profilePath: string | undefined,
  rawPlan: Plan,
  options: RunOptions = {},
): Promise<RunResult> {
  const plan = PlanSchema.parse(rawPlan);
  const profile = await resolveUiProfile(profilePath, options.environmentUrl);
  const base = allowedUrl(profile.baseUrl, profile.baseUrl);
  const outputDir = path.resolve(profile.outputDir, `run-${Date.now()}-${randomUUID()}`);
  await mkdir(outputDir, { recursive: true });
  const started = Date.now();
  const configured = {
    stepTimeoutMs: 30000,
    navigationTimeoutMs: 60000,
    caseTimeoutMs: 180000,
    ...profile.timeouts,
    ...options.timeouts,
  };
  const stepMs = Math.max(1, Math.min(options.stepTimeoutMs ?? Infinity, configured.stepTimeoutMs, 120000));
  const navigationMs = Math.max(
    1,
    Math.min(options.navigationTimeoutMs ?? Infinity, configured.navigationTimeoutMs, 180000),
  );
  const caseMs = Math.max(1, Math.min(options.caseTimeoutMs ?? Infinity, configured.caseTimeoutMs, 600000));
  const planPath = path.join(outputDir, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
  const report: VerificationReport = {
    requirement: plan.requirement,
    buildReference: plan.buildReference,
    company: plan.company,
    environment: new URL(base).origin,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    status: 'NOT_VERIFIED',
    cases: [],
    planPath,
    timeouts: { stepTimeoutMs: stepMs, navigationTimeoutMs: navigationMs, caseTimeoutMs: caseMs },
  };
  let browser: Browser | undefined;
  let initialError: string | undefined;
  try {
    if (options.signal?.aborted) throw new Error('Request cancelled');
    if (!plan.buildReference.ready) throw new Error('Build/deployment readiness was not declared');
    allowedUrl(plan.startUrl, base);
    for (const c of plan.cases) for (const s of c.steps) if (s.action === 'navigate') allowedUrl(s.url, base);
    const statePath = profile.storageState;
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (
      !Array.isArray(state.cookies) ||
      !Array.isArray(state.origins) ||
      (!state.cookies.length && !state.origins.length)
    )
      throw new Error('Saved authentication state is missing or empty');
    const launched = await launchUiBrowser({
      headless: profile.headless ?? true,
      channel: profile.channel,
      signal: options.signal,
      deadline: Date.now() + stepMs,
    });
    browser = launched.browser;
    report.browserChannel = launched.browserChannel;
    report.browserFallback = launched.browserFallback;
    for (const [index, c] of plan.cases.entries()) {
      const caseStart = Date.now();
      const result: CaseResult = { name: c.name, status: 'NOT_VERIFIED', durationMs: 0, steps: [] };
      report.cases.push(result);
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let stopped: string | undefined;
      let removeNavigationGuard: (() => Promise<void>) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closePromise: Promise<void> | undefined;
      let applicationActionDispatched = false;
      const collectSystemErrors = async () => {
        if (page)
          retainSystemErrors(
            result,
            await inspectSystemErrors(page, new URL(base).origin),
            applicationActionDispatched,
          );
      };
      const requireClearSystemErrors = async () => {
        await collectSystemErrors();
        if (result.systemErrors?.some(error => error.stage === 'after_action'))
          throw new FunctionalMismatch('D365 system error detected independently of the case criteria');
        if (result.systemErrors?.length) throw new Error('D365 system error already present before test actions');
        if (result.systemErrorInspectionIncomplete) throw new Error(result.systemErrorInspectionIncomplete);
      };
      const stop = (why: string) => {
        stopped ??= why;
        closePromise ??= (context ? context.close() : browser!.close()).catch(() => {});
      };
      const abort = () => stop('Request cancelled');
      const guard = () => {
        if (options.signal?.aborted) stop('Request cancelled');
        if (stopped) throw new Error(stopped);
        if (page) allowedUrl(page.url(), base);
      };
      const record = async (
        label: string,
        expected: string,
        fn: (s: StepResult, deadline: number) => Promise<void>,
        budgetMs = stepMs,
        assertion = false,
      ) => {
        const evidence: StepResult = { label, expected, observed: '', completed: false };
        result.steps.push(evidence);
        const deadline = Date.now() + budgetMs;
        const stepTimer = assertion
          ? undefined
          : setTimeout(() => stop(`Step deadline exceeded (${budgetMs} ms)`), budgetMs);
        try {
          await fn(evidence, deadline);
          evidence.completed = true;
        } catch (e) {
          evidence.observed ||= message(e);
          throw e;
        } finally {
          if (stepTimer) clearTimeout(stepTimer);
        }
      };
      try {
        if (options.signal?.aborted) throw new Error('Request cancelled');
        timer = setTimeout(() => stop(`Case deadline exceeded (${caseMs} ms)`), caseMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        context = await browser.newContext({ storageState: state, serviceWorkers: 'block', acceptDownloads: false });
        if (stopped || options.signal?.aborted) {
          stop(stopped ?? 'Request cancelled');
          throw new Error(stopped);
        }
        context.setDefaultTimeout(stepMs);
        context.setDefaultNavigationTimeout(navigationMs);
        // Popup events occur after their initial request. Block that request at
        // the context boundary while CDP validates primary-page redirect hops.
        await context.route('**/*', async route => {
          try {
            if (stopped) {
              await route.abort();
              return;
            }
            if (route.request().isNavigationRequest() && route.request().frame().page() !== page) {
              stop('Unexpected popup; verification stopped');
              await route.abort().catch(() => {});
              return;
            }
            await route.continue();
          } catch (error) {
            if (!stopped) stop(`Navigation blocked: ${message(error)}`);
            await route.abort().catch(() => {});
          }
        });
        page = await context.newPage();
        removeNavigationGuard = await installNavigationGuard(page, [new URL(base).origin], stop);
        page.on('popup', () => stop('Unexpected popup; verification stopped'));
        await record(
          'Open start page',
          plan.startUrl,
          async s => {
            await page!.goto(allowedUrl(plan.startUrl, base), { waitUntil: 'domcontentloaded' });
            guard();
            s.observed = 'Start page reached';
          },
          navigationMs,
        );
        const checkCompany = async () => {
          guard();
          const a: Assertion = { selector: plan.companySelector, check: 'text', expected: plan.company };
          const actual = await observe(page!, a);
          if (actual !== a.expected) throw new Error(`Company mismatch: expected ${plan.company}; observed ${actual}`);
        };
        await requireClearSystemErrors();
        await record(
          'Verify company',
          plan.company,
          async (s, deadline) => {
            await assertCheck(
              page!,
              { selector: plan.companySelector, check: 'text', expected: plan.company },
              false,
              s,
              deadline,
            );
            guard();
          },
          stepMs,
          true,
        );
        for (const a of c.preconditions) {
          guard();
          await record(
            `Precondition ${a.check}${a.check === 'text' ? ` (${a.match ?? 'exact'})` : ''} ${a.selector}`,
            String(a.expected),
            (s, deadline) => assertCheck(page!, a, false, s, deadline, c.scope),
            stepMs,
            true,
          );
        }
        for (const s of c.steps) {
          guard();
          await requireClearSystemErrors();
          await record(
            `${s.action}${s.action === 'assert' ? ` ${s.check}${s.check === 'text' ? ` (${s.match ?? 'exact'})` : ''}` : ''}${'selector' in s ? ` ${s.selector}` : ''}`,
            'expected' in s
              ? String(s.expected)
              : s.action === 'navigate'
                ? s.url
                : 'value' in s
                  ? s.value
                  : 'key' in s
                    ? s.key
                    : 'Complete action',
            async (evidence, deadline) => {
              await checkCompany();
              await execute(page!, s, base, evidence, deadline, c.scope, () => {
                applicationActionDispatched = true;
              });
              guard();
            },
            s.action === 'navigate' ? navigationMs : stepMs,
            s.action === 'assert',
          );
          await requireClearSystemErrors();
        }
        guard();
        await checkCompany();
        await requireClearSystemErrors();
        result.status = 'PASS';
      } catch (e) {
        await collectSystemErrors();
        result.status = !stopped && e instanceof FunctionalMismatch ? 'FAIL' : 'NOT_VERIFIED';
        if (result.systemErrors?.some(error => error.stage === 'after_action')) result.status = 'FAIL';
        result.reason = stopped ?? message(e);
        if (page && !page.isClosed() && !stopped) {
          const screenshot = path.join(outputDir, `case-${index + 1}-error.png`);
          try {
            await page.screenshot({ path: screenshot, timeout: Math.min(stepMs, 2000) });
            result.screenshot = screenshot;
          } catch {
            /* Evidence is best effort. */
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (context) {
          closePromise ??= context.close().catch(() => {});
          await closePromise;
        }
        await removeNavigationGuard?.();
        result.durationMs = Date.now() - caseStart;
      }
    }
  } catch (e) {
    initialError = message(e);
  } finally {
    await browser?.close().catch(() => {});
  }
  while (report.cases.length < plan.cases.length) {
    const c = plan.cases[report.cases.length];
    report.cases.push({
      name: c.name,
      status: 'NOT_VERIFIED',
      durationMs: 0,
      steps: [],
      reason: initialError ?? 'Run interrupted',
    });
  }
  report.durationMs = Date.now() - started;
  report.status = aggregateStatus(report.cases.map(c => c.status));
  const reportPath = path.join(outputDir, 'report.md');
  await writeFile(reportPath, renderReport(report), 'utf8');
  return { ...report, reportPath, planPath };
}
