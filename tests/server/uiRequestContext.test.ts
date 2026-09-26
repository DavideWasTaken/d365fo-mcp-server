import { expect, it, vi } from 'vitest';
import {
  isLocalUiRequest,
  withUiRequest,
  currentUiRequest,
  uiTelemetryArgs,
} from '../../src/server/uiRequestContext.js';
it('requires a local socket, local host and matching origin, ignoring forwarded addresses', () => {
  vi.stubEnv('WEBSITES_PORT', '');
  const request = (host: string, origin?: string, remoteAddress = '127.0.0.1') =>
    ({ socket: { remoteAddress }, headers: { host, origin, 'x-forwarded-for': '127.0.0.1' } }) as any;
  try {
    expect(isLocalUiRequest(request('localhost:8080'))).toBe(true);
    expect(isLocalUiRequest(request('localhost:8080', 'http://localhost:8080'))).toBe(true);
    expect(isLocalUiRequest(request('localhost:8080', 'https://evil.example'))).toBe(false);
    expect(isLocalUiRequest(request('evil.example'))).toBe(false);
    expect(isLocalUiRequest(request('localhost:8080', undefined, '10.0.0.2'))).toBe(false);
    expect(isLocalUiRequest(request('[::1]:8080', undefined, '::1'))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
it('isolates request abort signals and keeps capabilities out of telemetry', async () => {
  const a = new AbortController(),
    b = new AbortController();
  await Promise.all([
    withUiRequest({ local: true, signal: a.signal }, async () => {
      await Promise.resolve();
      a.abort();
      expect(currentUiRequest()?.signal.aborted).toBe(true);
    }),
    withUiRequest({ local: true, signal: b.signal }, async () => {
      await Promise.resolve();
      expect(currentUiRequest()?.signal.aborted).toBe(false);
    }),
  ]);
  expect(uiTelemetryArgs({ action: 'observe', sessionId: 'secret', value: 'private' })).toEqual({ action: 'observe' });
});
