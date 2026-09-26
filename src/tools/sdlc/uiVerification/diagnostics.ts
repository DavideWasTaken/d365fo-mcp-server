export type UiPhase = 'profile' | 'storage' | 'launch' | 'context' | 'navigation' | 'authentication' | 'operation';
export interface UiDiagnostic {
  phase: UiPhase;
  code: string;
  blockedOrigin?: string;
  browserChannel?: 'chromium' | 'msedge';
  fallbackFromCode?: string;
}

export class UiDiagnosticError extends Error {
  constructor(readonly diagnostic: UiDiagnostic) {
    super(formatUiDiagnostic(diagnostic));
  }
}

const safeCodes = new Set([
  'BROWSER_NOT_INSTALLED',
  'BROWSER_LAUNCH_FAILED',
  'CANCELLED',
  'DEADLINE_EXCEEDED',
  'NAVIGATION_BLOCKED',
  'REDIRECT_LIMIT',
  'INVALID_URL',
  'TIMEOUT',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_TOO_MANY_REDIRECTS',
  'ERR_ABORTED',
  'PROFILE_INVALID',
  'STORAGE_STATE_INVALID',
  'BROWSER_CONTEXT_FAILED',
  'NAVIGATION_FAILED',
  'NAVIGATION_GUARD_FAILED',
  'AUTHENTICATION_NOT_VERIFIED',
  'BROWSER_OPERATION_FAILED',
]);
const phases: UiPhase[] = ['profile', 'storage', 'launch', 'context', 'navigation', 'authentication', 'operation'];

export function safeBlockedOrigin(raw?: string): string | undefined {
  try {
    const url = new URL(raw ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Keep only recognized categories; raw Playwright messages can contain URLs, paths and page content. */
export function safeUiDiagnostic(error: unknown, phase: UiPhase): UiDiagnostic {
  const saved = (error as { diagnostic?: UiDiagnostic } | undefined)?.diagnostic;
  if (saved && phases.includes(saved.phase) && safeCodes.has(saved.code)) {
    const blockedOrigin = safeBlockedOrigin(saved.blockedOrigin);
    return {
      phase: saved.phase,
      code: saved.code,
      ...(blockedOrigin ? { blockedOrigin } : {}),
      ...(['chromium', 'msedge'].includes(saved.browserChannel ?? '') ? { browserChannel: saved.browserChannel } : {}),
      ...(saved.fallbackFromCode && safeCodes.has(saved.fallbackFromCode)
        ? { fallbackFromCode: saved.fallbackFromCode }
        : {}),
    };
  }
  const message = error instanceof Error ? error.message : '';
  const nativeCode = (error as { code?: string } | undefined)?.code;
  let code = (
    {
      profile: 'PROFILE_INVALID',
      storage: 'STORAGE_STATE_INVALID',
      launch: 'BROWSER_LAUNCH_FAILED',
      context: 'BROWSER_CONTEXT_FAILED',
      navigation: 'NAVIGATION_FAILED',
      authentication: 'AUTHENTICATION_NOT_VERIFIED',
      operation: 'BROWSER_OPERATION_FAILED',
    } as const
  )[phase] as string;
  if (
    phase === 'launch' &&
    /executable.*(?:doesn.t|does not) exist|distribution.*not found|please.*playwright install/i.test(message)
  )
    code = 'BROWSER_NOT_INSTALLED';
  else if (nativeCode && ['ENOENT', 'EACCES', 'EPERM'].includes(nativeCode)) code = nativeCode;
  else if (error instanceof Error && error.name === 'TimeoutError') code = 'TIMEOUT';
  else {
    const network = /\bnet::(ERR_[A-Z_]+)\b/.exec(message)?.[1];
    if (network && safeCodes.has(network)) code = network;
  }
  return { phase, code };
}

export function formatUiDiagnostic(diagnostic: UiDiagnostic): string {
  const hints: Record<string, string> = {
    BROWSER_NOT_INSTALLED:
      'Install Playwright Chromium (npx playwright install chromium) or select installed Microsoft Edge (msedge).',
    BROWSER_LAUNCH_FAILED: 'Check that the selected browser is installed and permitted to run.',
    NAVIGATION_BLOCKED:
      'The destination is outside the exact allowed origins or contains embedded credentials. Review the configured environment and authentication origins.',
    REDIRECT_LIMIT: 'The navigation exceeded the maximum 10 redirects. Check for a redirect loop.',
    NAVIGATION_GUARD_FAILED:
      'The browser navigation guard could not initialize or communicate with a frame. Start a new browser session before retrying.',
    STORAGE_STATE_INVALID: 'Refresh saved authentication or check the configured saved-state file.',
    PROFILE_INVALID: 'Check the environment URL, browser choice and profile configuration.',
  };
  return `UI ${diagnostic.phase} failed (${diagnostic.code})${diagnostic.browserChannel ? `; browser: ${diagnostic.browserChannel}` : ''}${diagnostic.fallbackFromCode ? `; Chromium fallback cause: ${diagnostic.fallbackFromCode}` : ''}${diagnostic.blockedOrigin ? `; blocked origin: ${diagnostic.blockedOrigin}` : ''}. ${hints[diagnostic.code] ?? 'Check this phase and retry after correcting the cause.'}`;
}
