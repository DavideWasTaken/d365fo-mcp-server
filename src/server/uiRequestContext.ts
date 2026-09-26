import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';

export interface UiRequestContext {
  local: boolean;
  signal: AbortSignal;
}
const requests = new AsyncLocalStorage<UiRequestContext>();
export const currentUiRequest = () => requests.getStore();
export const withUiRequest = <T>(context: UiRequestContext, run: () => T): T => requests.run(context, run);

export function isLocalUiRequest(req: Pick<Request, 'socket' | 'headers'>): boolean {
  const peer = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') || process.env.WEBSITES_PORT) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) ||
      host.username ||
      host.password ||
      host.pathname !== '/'
    )
      return false;
    const origin = req.headers.origin;
    return !origin || new URL(origin).origin === host.origin;
  } catch {
    return false;
  }
}

/** Never include session capabilities, page data or input values in shared telemetry. */
export function uiTelemetryArgs(args: unknown): Record<string, unknown> {
  const value = args as Record<string, unknown> | undefined;
  return { action: typeof value?.action === 'string' ? value.action.slice(0, 30) : 'unknown' };
}
