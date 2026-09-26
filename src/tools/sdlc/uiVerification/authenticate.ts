import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Browser } from 'playwright';
import { MissingUiEnvironmentUrl, resolveUiProfile } from './profile.js';
import { allowedNavigationUrl, defaultAuthenticationOrigins, installNavigationGuard } from './navigation.js';
import { visibleMatches } from './locators.js';
import { launchUiBrowser } from './browserLaunch.js';
import { formatUiDiagnostic, safeUiDiagnostic, type UiDiagnostic, type UiPhase } from './diagnostics.js';

export interface AuthenticationInput {
  environmentUrl?: string;
  companySelector: string;
  company: string;
  timeoutMs?: number;
}
export interface AuthenticationOptions {
  signal?: AbortSignal;
  /** Internal fixture override; public authentication always opens a visible browser. */
  headless?: boolean;
  timeoutMs?: number;
}
export interface AuthenticationResult {
  status: 'AUTHENTICATED' | 'NOT_VERIFIED';
  storageStatePath?: string;
  reason?: string;
  diagnostic?: UiDiagnostic;
  browserChannel?: string;
  browserFallback?: string;
}

/** Human login in an owned context; no credential collection or automated login steps. */
export async function authenticateUi(
  profilePath: string | undefined,
  input: AuthenticationInput,
  options: AuthenticationOptions = {},
): Promise<AuthenticationResult> {
  const requestedMs = input.timeoutMs ?? 180000;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? requestedMs, requestedMs, 300000));
  const deadline = Date.now() + timeoutMs;
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  let cleanupGuard: (() => Promise<void>) | undefined;
  let temporaryPath: string | undefined;
  let stopped: string | undefined;
  let stoppedDiagnostic: UiDiagnostic | undefined;
  let phase: UiPhase = 'profile';
  let browserChannel: string | undefined;
  let browserFallback: string | undefined;
  const stop = (reason: string, diagnostic?: UiDiagnostic) => {
    if (!stopped) stoppedDiagnostic = diagnostic;
    stopped ??= reason;
    if (browser) closing ??= browser.close().catch(() => {});
  };
  const abort = () =>
    stop('Authentication cancelled; existing saved state was preserved', { phase, code: 'CANCELLED' });
  const expire = () =>
    stop('Authentication deadline exceeded; existing saved state was preserved', { phase, code: 'DEADLINE_EXCEEDED' });
  const check = () => {
    if (options.signal?.aborted) abort();
    if (Date.now() >= deadline) expire();
    if (stopped) throw new Error(stopped);
  };
  const timer = setTimeout(expire, timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    check();
    const profile = await resolveUiProfile(profilePath, input.environmentUrl);
    const origin = new URL(profile.baseUrl).origin;
    const baseUrl = allowedNavigationUrl(profile.baseUrl, [origin]);
    const allowedOrigins = [origin, ...(profile.authenticationOrigins ?? defaultAuthenticationOrigins)];
    phase = 'storage';
    let state: Awaited<ReturnType<import('playwright').BrowserContext['storageState']>> | undefined;
    try {
      state = JSON.parse(await readFile(profile.storageState, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    check();
    phase = 'launch';
    const launched = await launchUiBrowser({
      headless: options.headless ?? false,
      channel: profile.channel,
      signal: options.signal,
      deadline,
    });
    ({ browser, browserChannel, browserFallback } = launched);
    check();
    phase = 'context';
    const context = await browser.newContext({ storageState: state, serviceWorkers: 'block', acceptDownloads: false });
    check();
    const page = await context.newPage();
    context.on('page', () => stop('Unexpected popup during authentication; existing saved state was preserved'));
    // The page event fires after a popup's first request. Block that request at
    // context level; the main page still uses native CDP interception per redirect hop.
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        let primary = false;
        try {
          primary = request.frame().page() === page;
        } catch {
          /* Unknown document ownership is blocked. */
        }
        if (!primary) {
          await route.abort('blockedbyclient').catch(() => {});
          stop('Unexpected popup during authentication; existing saved state was preserved');
          return;
        }
      }
      await route.continue().catch(() => {});
    });
    page.setDefaultTimeout(500);
    cleanupGuard = await installNavigationGuard(page, allowedOrigins, stop);
    check();
    phase = 'navigation';
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
    phase = 'authentication';
    while (true) {
      check();
      if (new URL(page.url()).origin === origin) {
        // Missing/incorrect company is expected while the human finishes login or selects a company.
        const matches = await visibleMatches(page, input.companySelector);
        const count = await matches.count();
        if (count > 1) throw new Error('Company selector matches multiple visible elements');
        if (count === 1) {
          const company = (await matches.innerText()).trim();
          check();
          if (company === input.company && new URL(page.url()).origin === origin) {
            const savedState = await context.storageState({ indexedDB: true });
            check();
            if (new URL(page.url()).origin !== origin) continue;
            phase = 'storage';
            await mkdir(path.dirname(profile.storageState), { recursive: true });
            temporaryPath = `${profile.storageState}.${randomUUID()}.tmp`;
            await writeFile(temporaryPath, JSON.stringify(savedState), { flag: 'wx', mode: 0o600 });
            check();
            // Commit synchronously after the final cancellation/deadline check: an abort cannot
            // interleave a successful rename and cause us to report failure after replacing state.
            renameSync(temporaryPath, profile.storageState);
            temporaryPath = undefined;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
            return { status: 'AUTHENTICATED', storageStatePath: profile.storageState, browserChannel, browserFallback };
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (error instanceof MissingUiEnvironmentUrl) throw error;
    // Browser errors can contain authentication URLs or data; never return them verbatim.
    const diagnostic = stoppedDiagnostic ?? safeUiDiagnostic(error, phase);
    return {
      status: 'NOT_VERIFIED',
      reason: stopped ?? formatUiDiagnostic(diagnostic),
      diagnostic,
      browserChannel,
      browserFallback,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (browser) await (closing ?? browser.close().catch(() => {}));
    await cleanupGuard?.();
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
