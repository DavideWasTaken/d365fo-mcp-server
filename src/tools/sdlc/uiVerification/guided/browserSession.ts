import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { inspectSystemErrors } from '../systemErrors.js';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, type ElementHandle, type Page } from 'playwright';
import { MissingUiEnvironmentUrl, resolveUiProfile } from '../profile.js';
import { allowedNavigationUrl, defaultAuthenticationOrigins, installNavigationGuard } from '../navigation.js';
import { launchUiBrowser } from '../browserLaunch.js';
import { formatUiDiagnostic, safeUiDiagnostic, type UiDiagnostic, type UiPhase } from '../diagnostics.js';
import {
  ObservedTargets,
  GuidedBrowserError,
  cloneTarget,
  disposeTarget,
  uniqueCompany,
  passwordSelector,
  type ObservedTarget,
  type ObservedNode,
} from './targets.js';
export { GuidedBrowserError } from './targets.js';
export interface GuidedObservation {
  snapshotId: string;
  url: string;
  phase: 'AUTH_REQUIRED' | 'DISCOVERING';
  nodes: ObservedNode[];
  truncated: boolean;
  image?: { data: string; mimeType: 'image/png' | 'image/jpeg' };
  capturedAt: string;
}
export interface GuidedBrowserOptions {
  headless?: boolean;
  signal?: AbortSignal;
  startUrl?: string;
  timeoutMs?: number;
}
type Profile = Awaited<ReturnType<typeof resolveUiProfile>>;

export class GuidedBrowser {
  page!: Page;
  context!: BrowserContext;
  private registry!: ObservedTargets;
  private cleanupGuard?: () => Promise<void>;
  private closing?: Promise<void>;
  private stopped?: string;
  private stoppedDiagnostic?: UiDiagnostic;
  private phase: UiPhase = 'context';
  private caseId?: string;
  private operation?: { signal?: AbortSignal; deadline: number };
  private seenCases = new Set<string>();
  private company?: { target: ObservedTarget; expected: string };
  private readonly origin: string;
  private readonly startUrl: string;
  private readonly abort = () => this.stop('Guided browser request cancelled');
  private constructor(
    readonly profile: Profile,
    private readonly browser: Browser,
    private readonly options: GuidedBrowserOptions,
    readonly browserChannel: string,
    readonly browserFallback?: string,
  ) {
    this.origin = new URL(profile.baseUrl).origin;
    this.startUrl = allowedNavigationUrl(options.startUrl ?? profile.baseUrl, [this.origin], profile.baseUrl);
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  static async open(
    profilePath: string | undefined,
    environmentUrl?: string,
    options: GuidedBrowserOptions = {},
  ): Promise<GuidedBrowser> {
    let result: GuidedBrowser | undefined;
    let browser: Browser | undefined;
    let expired = false;
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30000, 45000));
    const deadline = Date.now() + timeoutMs;
    let phase: UiPhase = 'profile';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const profile = await resolveUiProfile(profilePath, environmentUrl);
          if (expired || options.signal?.aborted)
            throw new GuidedBrowserError('NOT_VERIFIED', 'Guided browser start cancelled');
          phase = 'launch';
          const launched = await launchUiBrowser({
            headless: options.headless ?? false,
            channel: profile.channel,
            signal: options.signal,
            deadline,
          });
          browser = launched.browser;
          if (expired || options.signal?.aborted) {
            await browser.close();
            throw new GuidedBrowserError('NOT_VERIFIED', 'Guided browser start cancelled');
          }
          result = new GuidedBrowser(profile, browser, options, launched.browserChannel, launched.browserFallback);
          result.setOperation(options.signal, Math.max(1, deadline - Date.now()));
          await result.newContext(() => result!.checkOperation(), Math.max(1, deadline - Date.now()));
          result.setOperation();
          result.ensureOpen();
          return result;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            result?.stop('Guided browser start deadline exceeded');
            void browser?.close().catch(() => {});
            reject(new GuidedBrowserError('NOT_VERIFIED', 'Guided browser start deadline exceeded'));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      await browser?.close().catch(() => {});
      if (error instanceof GuidedBrowserError || error instanceof MissingUiEnvironmentUrl) throw error;
      const diagnostic = result?.stoppedDiagnostic ?? safeUiDiagnostic(error, result?.phase ?? phase);
      throw new GuidedBrowserError('NOT_VERIFIED', result?.stopped ?? formatUiDiagnostic(diagnostic), diagnostic);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private ensureOpen(): void {
    if (this.options.signal?.aborted) this.abort();
    if (this.stopped || this.page?.isClosed())
      throw new GuidedBrowserError('NOT_VERIFIED', this.stopped ?? 'Guided browser is closed', this.stoppedDiagnostic);
  }
  private stop(reason: string, diagnostic?: UiDiagnostic): void {
    if (!this.stopped) this.stoppedDiagnostic = diagnostic;
    this.stopped ??= reason;
    this.closing ??= this.browser.close().catch(() => {});
  }
  setOperation(signal?: AbortSignal, timeoutMs?: number): void {
    this.operation =
      signal || timeoutMs !== undefined
        ? { signal, deadline: Date.now() + Math.max(1, Math.min(timeoutMs ?? 30000, 45000)) }
        : undefined;
    const timeout = Math.max(1, (this.operation?.deadline ?? Date.now() + 30000) - Date.now());
    this.context?.setDefaultTimeout(timeout);
    this.context?.setDefaultNavigationTimeout(timeout);
  }
  private checkOperation(operation = this.operation, deadline = operation?.deadline ?? Infinity): void {
    if (this.options.signal?.aborted) this.abort();
    if (this.stopped) throw new GuidedBrowserError('NOT_VERIFIED', this.stopped, this.stoppedDiagnostic);
    if (operation?.signal?.aborted || (operation && operation !== this.operation) || Date.now() >= deadline)
      throw new GuidedBrowserError('CANCELLED', 'Guided browser operation cancelled or its deadline expired');
  }
  private async bounded<T>(fn: (check: () => void, remaining: () => number) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const operation = this.operation;
    const deadline = operation?.deadline ?? Date.now() + 30000;
    const check = () => this.checkOperation(operation, deadline);
    const remaining = () => Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      check();
      const cancel = new Promise<never>((_, reject) => {
        abort = () =>
          reject(new GuidedBrowserError('CANCELLED', 'Guided browser operation cancelled or its deadline expired'));
        operation?.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, remaining());
      });
      const value = await Promise.race([fn(check, remaining), cancel]);
      check();
      this.ensureOpen();
      return value;
    } catch (error) {
      if (this.stopped) throw new GuidedBrowserError('NOT_VERIFIED', this.stopped, this.stoppedDiagnostic);
      if (error instanceof GuidedBrowserError) throw error;
      const diagnostic = safeUiDiagnostic(error, 'operation');
      throw new GuidedBrowserError('NOT_VERIFIED', formatUiDiagnostic(diagnostic), diagnostic);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) operation?.signal?.removeEventListener('abort', abort);
    }
  }
  private async newContext(check = () => this.checkOperation(), timeoutMs = 30000): Promise<void> {
    this.phase = 'storage';
    let state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
    try {
      state = JSON.parse(await readFile(this.profile.storageState, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    check();
    this.phase = 'context';
    this.context = await this.browser.newContext({
      storageState: state,
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: { width: 1280, height: 720 },
    });
    check();
    this.context.setDefaultTimeout(timeoutMs);
    this.context.setDefaultNavigationTimeout(timeoutMs);
    this.page = await this.context.newPage();
    check();
    const primary = this.page;
    this.context.on('page', () => this.stop('Unexpected popup; guided browser stopped'));
    await this.context.route('**/*', async route => {
      if (route.request().isNavigationRequest()) {
        let own = false;
        try {
          own = route.request().frame().page() === primary;
        } catch {
          /* unknown ownership is blocked */
        }
        if (!own) {
          this.stop('Unexpected popup; guided browser stopped');
          await route.abort().catch(() => {});
          return;
        }
      }
      if (this.stopped) await route.abort().catch(() => {});
      else await route.continue().catch(() => {});
    });
    this.registry = new ObservedTargets(this.page);
    this.cleanupGuard = await installNavigationGuard(
      this.page,
      [this.origin, ...(this.profile.authenticationOrigins ?? defaultAuthenticationOrigins)],
      (reason, diagnostic) => this.stop(reason, diagnostic),
    );
    check();
    this.phase = 'navigation';
    await this.page.goto(this.startUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    check();
  }
  async prepareCase(caseId: string): Promise<void> {
    await this.bounded(async (check, remaining) => {
      if (this.caseId === caseId) return;
      if (this.seenCases.has(caseId))
        throw new GuidedBrowserError('NOT_VERIFIED', 'A completed case cannot be prepared again');
      if (this.caseId !== undefined) {
        await this.registry.invalidate();
        if (this.company) await disposeTarget(this.company.target);
        this.company = undefined;
        await this.context.close();
        await this.cleanupGuard?.();
        check();
        await this.newContext(check, remaining());
      } else await this.registry.invalidate();
      check();
      this.caseId = caseId;
      this.seenCases.add(caseId);
    });
  }
  async inspectSystemErrors() {
    return this.bounded(async () => inspectSystemErrors(this.page, new URL(this.profile.baseUrl).origin));
  }
  private authRequired(): boolean {
    return this.page.frames().some(frame => {
      try {
        return new URL(frame.url()).origin !== this.origin && frame.url() !== 'about:blank';
      } catch {
        return true;
      }
    });
  }
  async observe(
    options: { scopeRef?: string; filter?: string; screenshot?: boolean } = {},
  ): Promise<GuidedObservation> {
    return this.bounded(async (check, remaining) => {
      if (this.authRequired()) {
        await this.registry.invalidate();
        return {
          snapshotId: randomUUID(),
          url: new URL(this.page.url()).origin,
          phase: 'AUTH_REQUIRED',
          nodes: [],
          truncated: false,
          capturedAt: new Date().toISOString(),
        };
      }
      const captured = await this.registry.capture(options, check, remaining());
      check();
      this.ensureOpen();
      if (this.authRequired()) {
        await this.registry.invalidate();
        throw new GuidedBrowserError('AUTH_REQUIRED', 'Complete human authentication before observing the application');
      }
      const result: GuidedObservation = {
        ...captured,
        url: this.page.url(),
        phase: 'DISCOVERING',
        capturedAt: new Date().toISOString(),
      };
      if (options.screenshot) {
        const mask = this.page.frames().map(frame => frame.locator(passwordSelector));
        const buffer = await this.page.screenshot({
          type: 'jpeg',
          quality: 45,
          fullPage: false,
          mask,
          maskColor: '#000000',
          timeout: remaining(),
        });
        check();
        this.ensureOpen();
        if (this.authRequired()) {
          await this.registry.invalidate();
          throw new GuidedBrowserError(
            'AUTH_REQUIRED',
            'Complete human authentication before observing the application',
          );
        }
        if (buffer.byteLength <= 1024 * 1024)
          result.image = { data: buffer.toString('base64'), mimeType: 'image/jpeg' };
      }
      return result;
    });
  }
  async resolve(snapshotId: string, ref: string): Promise<ElementHandle> {
    return this.bounded(async () => {
      if (this.authRequired())
        throw new GuidedBrowserError(
          'AUTH_REQUIRED',
          'Complete human authentication before resolving an application target',
        );
      return (await this.registry.resolve(snapshotId, ref)).handle;
    });
  }
  async bindCompany(snapshotId: string, ref: string, company: string): Promise<void> {
    await this.bounded(async check => {
      if (this.authRequired())
        throw new GuidedBrowserError('AUTH_REQUIRED', 'Complete human authentication before binding the company');
      const target = await this.registry.resolve(snapshotId, ref);
      await uniqueCompany(this.page, target, company);
      check();
      if (this.company && this.company.expected !== company)
        throw new GuidedBrowserError('NOT_VERIFIED', 'The bound company cannot be changed');
      const binding = await cloneTarget(target);
      let temporaryPath: string | undefined;
      try {
        const newGuard = await installNavigationGuard(this.page, [this.origin], (reason, diagnostic) =>
          this.stop(reason, diagnostic),
        );
        await this.cleanupGuard?.();
        this.cleanupGuard = newGuard;
        check();
        const state = await this.context.storageState({ indexedDB: true });
        check();
        this.ensureOpen();
        await uniqueCompany(this.page, binding, company);
        check();
        await mkdir(path.dirname(this.profile.storageState), { recursive: true });
        check();
        temporaryPath = `${this.profile.storageState}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
        await uniqueCompany(this.page, binding, company);
        check();
        this.ensureOpen();
        if (this.authRequired())
          throw new GuidedBrowserError(
            'NOT_VERIFIED',
            'Company environment changed before authentication state could be saved',
          );
        renameSync(temporaryPath, this.profile.storageState);
        temporaryPath = undefined;
        if (this.company) await disposeTarget(this.company.target);
        this.company = { target: binding, expected: company };
      } catch (error) {
        await disposeTarget(binding);
        throw error;
      } finally {
        if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
      }
    });
  }
  async checkCompany(): Promise<void> {
    await this.bounded(async () => {
      if (!this.company || this.authRequired())
        throw new GuidedBrowserError('NOT_VERIFIED', 'The current case has no verified company binding');
      try {
        await uniqueCompany(this.page, this.company.target, this.company.expected);
      } catch {
        // Fork: a bound element that is gone is not a different company. A full
        // page load (a ?mi= link, a reload) replaces every element while the page
        // still shows the company, and reporting that as NOT_VERIFIED ended the
        // case. It is recoverable: re-observe and confirm the company again. An
        // element still in the page that no longer matches stays NOT_VERIFIED.
        const attached = await this.company.target.handle.evaluate(el => el.isConnected).catch(() => false);
        if (!attached)
          throw new GuidedBrowserError(
            'NEEDS_OBSERVATION',
            'The bound company control is gone (the page reloaded?). Observe again and repeat case begin ' +
              'with the new snapshotId and companyRef; the case keeps its progress',
          );
        throw new GuidedBrowserError('NOT_VERIFIED', 'The company control changed or no longer matches the bound company');
      }
    });
  }
  async close(): Promise<void> {
    this.stopped ??= 'Guided browser is closed';
    this.options.signal?.removeEventListener('abort', this.abort);
    this.closing ??= this.browser.close().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.closing;
          await this.cleanupGuard?.();
        })(),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 30000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
