import { chromium, type Browser } from 'playwright';
import { safeUiDiagnostic, UiDiagnosticError } from './diagnostics.js';

export interface UiBrowserLaunch {
  browser: Browser;
  browserChannel: string;
  browserFallback?: string;
}

/** Launch only: navigation and authentication must never trigger a browser switch. */
export async function launchUiBrowser(
  options: { channel?: string; headless?: boolean; signal?: AbortSignal; deadline?: number } = {},
): Promise<UiBrowserLaunch> {
  const deadline = options.deadline ?? Date.now() + 30000;
  const check = () => {
    if (options.signal?.aborted) throw new UiDiagnosticError({ phase: 'launch', code: 'CANCELLED' });
    if (Date.now() >= deadline) throw new UiDiagnosticError({ phase: 'launch', code: 'DEADLINE_EXCEEDED' });
  };
  const launch = async (channel: string): Promise<Browser> => {
    check();
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const pending = chromium
      .launch({
        headless: options.headless ?? false,
        // Bundled Chromium keeps the existing headless-shell behavior.
        channel: channel === 'chromium' ? undefined : channel,
        timeout: Math.max(1, deadline - Date.now()),
      })
      .then(async browser => {
        if (abandoned || options.signal?.aborted || Date.now() >= deadline) {
          await browser.close().catch(() => {});
          check();
          throw new UiDiagnosticError({ phase: 'launch', code: 'DEADLINE_EXCEEDED' });
        }
        return browser;
      });
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          abort = () => {
            abandoned = true;
            reject(new UiDiagnosticError({ phase: 'launch', code: 'CANCELLED' }));
          };
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
          timer = setTimeout(
            () => {
              abandoned = true;
              reject(new UiDiagnosticError({ phase: 'launch', code: 'DEADLINE_EXCEEDED' }));
            },
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
  };
  const auto = !options.channel || options.channel === 'auto';
  const channel = auto ? 'chromium' : options.channel!;
  try {
    return { browser: await launch(channel), browserChannel: channel };
  } catch (error) {
    check();
    const primary = safeUiDiagnostic(error, 'launch');
    if (!auto || error instanceof UiDiagnosticError)
      throw new UiDiagnosticError({
        ...primary,
        ...(channel === 'chromium' || channel === 'msedge' ? { browserChannel: channel } : {}),
      });
    try {
      return {
        browser: await launch('msedge'),
        browserChannel: 'msedge',
        browserFallback: `Chromium could not launch (${primary.code}); using installed Microsoft Edge.`,
      };
    } catch (fallbackError) {
      throw new UiDiagnosticError({
        ...safeUiDiagnostic(fallbackError, 'launch'),
        browserChannel: 'msedge',
        fallbackFromCode: primary.code,
      });
    }
  }
}
