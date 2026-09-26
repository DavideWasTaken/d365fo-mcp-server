import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { PlanSchema, ProfileSchema, type Plan, type Assertion, type Step } from './contract.js';
import { aggregateStatus, renderReport, type CaseResult, type VerificationReport, type StepResult } from './report.js';

export interface RunOptions {
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  caseTimeoutMs?: number;
}
export interface RunResult extends VerificationReport {
  reportPath: string;
}
class FunctionalMismatch extends Error {}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000);
function allowedUrl(raw: string, base: string): string {
  const u = new URL(raw, base);
  if (u.origin !== new URL(base).origin || !['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('URL is outside the configured exact origin');
  return u.href;
}
async function unique(page: Page, selector: string): Promise<Locator> {
  // Force CSS, preventing Playwright selector engines or arbitrary evaluation.
  const locator = page.locator(`css=${selector}`);
  await locator.waitFor({ state: 'attached' });
  const count = await locator.count();
  if (count !== 1) throw new Error(`Selector must match exactly one element; observed ${count}: ${selector}`);
  return locator;
}
async function observe(page: Page, a: Assertion): Promise<string | boolean> {
  const l = await unique(page, a.selector);
  switch (a.check) {
    case 'visible':
      return l.isVisible();
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
): Promise<void> {
  while (true) {
    const actual = await observe(page, a);
    evidence.observed = String(actual).slice(0, 2000);
    if (actual === a.expected) return;
    if (Date.now() >= deadline - 50)
      throw functional
        ? new FunctionalMismatch(`Expected ${String(a.expected)}; observed ${String(actual)}`)
        : new Error(`Precondition not met: expected ${String(a.expected)}; observed ${String(actual)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function execute(page: Page, s: Step, base: string, evidence: StepResult, deadline: number): Promise<void> {
  if (s.action === 'navigate') {
    await page.goto(allowedUrl(s.url, base), { waitUntil: 'domcontentloaded' });
    evidence.observed = 'Navigation completed';
    return;
  }
  if (s.action === 'assert') {
    await assertCheck(page, s, true, evidence, deadline);
    return;
  }
  const l = await unique(page, s.selector);
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

/** Bounds can only be lowered by internal tests; callers cannot extend either deadline. */
export async function runVerification(
  profilePath: string,
  rawPlan: Plan,
  options: RunOptions = {},
): Promise<RunResult> {
  const plan = PlanSchema.parse(rawPlan);
  const profile = ProfileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  const base = allowedUrl(profile.baseUrl, profile.baseUrl);
  const outputDir = path.resolve(path.dirname(profilePath), profile.outputDir, `run-${Date.now()}-${randomUUID()}`);
  await mkdir(outputDir, { recursive: true });
  const started = Date.now();
  const stepMs = Math.max(1, Math.min(options.stepTimeoutMs ?? 15000, 15000));
  const caseMs = Math.max(1, Math.min(options.caseTimeoutMs ?? 120000, 120000));
  const report: VerificationReport = {
    requirement: plan.requirement,
    buildReference: plan.buildReference,
    company: plan.company,
    environment: new URL(base).origin,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    status: 'NOT_VERIFIED',
    cases: [],
  };
  let browser: Browser | undefined;
  let initialError: string | undefined;
  try {
    if (options.signal?.aborted) throw new Error('Request cancelled');
    if (!plan.buildReference.ready) throw new Error('Build/deployment readiness was not declared');
    allowedUrl(plan.startUrl, base);
    for (const c of plan.cases) for (const s of c.steps) if (s.action === 'navigate') allowedUrl(s.url, base);
    const statePath = path.resolve(path.dirname(profilePath), profile.storageState);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (
      !Array.isArray(state.cookies) ||
      !Array.isArray(state.origins) ||
      (!state.cookies.length && !state.origins.length)
    )
      throw new Error('Saved authentication state is missing or empty');
    browser = await chromium.launch({ headless: profile.headless ?? true, channel: profile.channel, timeout: stepMs });
    for (const [index, c] of plan.cases.entries()) {
      const caseStart = Date.now();
      const result: CaseResult = { name: c.name, status: 'NOT_VERIFIED', durationMs: 0, steps: [] };
      report.cases.push(result);
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let stopped: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closePromise: Promise<void> | undefined;
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
      ) => {
        const evidence: StepResult = { label, expected, observed: '', completed: false };
        result.steps.push(evidence);
        const deadline = Date.now() + stepMs;
        const stepTimer = setTimeout(() => stop('Step deadline exceeded (maximum 15 seconds)'), stepMs);
        try {
          await fn(evidence, deadline);
          evidence.completed = true;
        } catch (e) {
          evidence.observed ||= message(e);
          throw e;
        } finally {
          clearTimeout(stepTimer);
        }
      };
      try {
        if (options.signal?.aborted) throw new Error('Request cancelled');
        timer = setTimeout(() => stop('Case deadline exceeded (maximum 120 seconds)'), caseMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        context = await browser.newContext({ storageState: state, serviceWorkers: 'block', acceptDownloads: false });
        if (stopped || options.signal?.aborted) {
          stop(stopped ?? 'Request cancelled');
          throw new Error(stopped);
        }
        context.setDefaultTimeout(stepMs);
        context.setDefaultNavigationTimeout(stepMs);
        await context.route('**/*', async route => {
          if (stopped) {
            await route.abort().catch(() => {});
            return;
          }
          try {
            if (route.request().isNavigationRequest()) allowedUrl(route.request().url(), base);
            // Playwright routing may skip later browser HTTP redirect hops. Never
            // fulfill a redirect: stop before any second hop can leave this origin.
            if (route.request().isNavigationRequest()) {
              const response = await route.fetch({ maxRedirects: 0, timeout: stepMs });
              if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
                throw new Error(
                  'HTTP navigation redirects are unsupported. Use the final application URL and refresh saved login.',
                );
              }
              if (stopped) {
                await route.abort().catch(() => {});
                return;
              }
              await route.fulfill({ response });
            } else await route.continue();
          } catch (e) {
            stop(`Navigation/network blocked: ${message(e)}`);
            await route.abort().catch(() => {});
          }
        });
        page = await context.newPage();
        page.on('popup', () => stop('Unexpected popup; verification stopped'));
        await record('Open start page', plan.startUrl, async s => {
          await page!.goto(allowedUrl(plan.startUrl, base), { waitUntil: 'domcontentloaded' });
          guard();
          s.observed = 'Start page reached';
        });
        const checkCompany = async () => {
          guard();
          const a: Assertion = { selector: plan.companySelector, check: 'text', expected: plan.company };
          const actual = await observe(page!, a);
          if (actual !== a.expected) throw new Error(`Company mismatch: expected ${plan.company}; observed ${actual}`);
        };
        await record('Verify company', plan.company, async (s, deadline) => {
          await assertCheck(
            page!,
            { selector: plan.companySelector, check: 'text', expected: plan.company },
            false,
            s,
            deadline,
          );
          guard();
        });
        for (const a of c.preconditions) {
          guard();
          await record(`Precondition ${a.check} ${a.selector}`, String(a.expected), (s, deadline) =>
            assertCheck(page!, a, false, s, deadline),
          );
        }
        for (const s of c.steps) {
          guard();
          await record(
            `${s.action}${'selector' in s ? ` ${s.selector}` : ''}`,
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
              await execute(page!, s, base, evidence, deadline);
              guard();
            },
          );
        }
        guard();
        await checkCompany();
        result.status = 'PASS';
      } catch (e) {
        result.status = !stopped && e instanceof FunctionalMismatch ? 'FAIL' : 'NOT_VERIFIED';
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
        result.durationMs = Date.now() - caseStart;
      }
    }
  } catch (e) {
    initialError = message(e);
  } finally {
    await browser?.close().catch(() => {});
  }
  while (report.cases.length < 2) {
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
  return { ...report, reportPath };
}
