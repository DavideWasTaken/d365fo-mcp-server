import type { Page } from 'playwright';

class ChildTargetDetached extends Error {}

export function allowedNavigationUrl(raw: string, origins: string[], base?: string): string {
  const url = new URL(raw, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !origins.includes(url.origin))
    throw new Error('URL is outside the configured exact HTTP(S) origins or contains embedded credentials');
  return url.href;
}

/** Intercept every native browser Document request, including each HTTP redirect hop. */
export async function installNavigationGuard(
  page: Page,
  allowedOrigins: string[],
  onBlocked: (reason: string) => void,
): Promise<() => Promise<void>> {
  const origins = allowedOrigins.map(value => {
    const url = new URL(value);
    allowedNavigationUrl(value, [url.origin]);
    if (url.href !== `${url.origin}/`) throw new Error('Navigation allowlist entries must be exact origins');
    return url.origin;
  });
  const session = await page.context().newCDPSession(page);
  type Command = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  type PausedRequest = { requestId: string; redirectedRequestId?: string; request: { url: string } };
  type ChildMessage = { id?: number; method?: string; params?: any; result?: unknown; error?: { message: string } };
  const fetchOptions = { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] };
  const attachOptions = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
    filter: [{ type: 'iframe' }, { exclude: true }],
  };
  const pending = new Set<(reason: Error) => void>();
  let blocked = false;
  let disposed = false;
  let nextCommand = 0;
  const block = (error: unknown) => {
    if (error instanceof ChildTargetDetached || blocked || disposed || page.isClosed()) return;
    blocked = true;
    onBlocked(`Navigation blocked: ${error instanceof Error ? error.message : String(error)}`);
  };
  const paused = async (send: Command, redirects: Map<string, number>, event: PausedRequest) => {
    try {
      if (blocked) {
        await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      allowedNavigationUrl(event.request.url, origins);
      const depth = event.redirectedRequestId ? (redirects.get(event.redirectedRequestId) ?? 0) + 1 : 0;
      if (event.redirectedRequestId) redirects.delete(event.redirectedRequestId);
      if (depth > 10) throw new Error('Navigation redirect limit exceeded (maximum 10 redirects)');
      redirects.set(event.requestId, depth);
      await send('Fetch.continueRequest', { requestId: event.requestId });
    } catch (error) {
      const failure = send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(
        () => {},
      );
      block(error);
      await failure;
    }
  };
  // CDP sessions are target-specific. An out-of-process iframe has its own target
  // and must install Fetch before its paused runtime is released. Non-flattened
  // transport lets public Playwright CDPSession APIs address nested sessions.
  const endpoint = (send: Command) => {
    const redirects = new Map<string, number>();
    const children = new Map<string, { receive: (message: ChildMessage) => void; close: () => void }>();
    const receive = (message: ChildMessage) => {
      const event = message.params;
      if (message.method === 'Fetch.requestPaused') void paused(send, redirects, event);
      if (message.method === 'Target.receivedMessageFromTarget')
        children.get(event.sessionId)?.receive(JSON.parse(event.message));
      if (message.method === 'Target.detachedFromTarget') {
        children.get(event.sessionId)?.close();
        children.delete(event.sessionId);
      }
      if (message.method === 'Target.attachedToTarget') {
        let childClosed = false;
        const responses = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
        const childSend: Command = (method, params = {}) =>
          new Promise((resolve, reject) => {
            if (childClosed) {
              reject(new ChildTargetDetached('Child frame detached'));
              return;
            }
            const id = ++nextCommand;
            const timer = setTimeout(() => finish(new Error('Child-frame navigation guard command timed out')), 5000);
            const finish = (error?: Error, result?: unknown) => {
              clearTimeout(timer);
              responses.delete(id);
              pending.delete(finish);
              if (error) reject(error);
              else resolve(result);
            };
            pending.add(finish);
            responses.set(id, { resolve: value => finish(undefined, value), reject: finish });
            void send('Target.sendMessageToTarget', {
              sessionId: event.sessionId,
              message: JSON.stringify({ id, method, params }),
            }).catch(error => finish(error));
          });
        const child = endpoint(childSend);
        children.set(event.sessionId, {
          receive: message => {
            if (message.id !== undefined) {
              const response = responses.get(message.id);
              if (message.error) response?.reject(new Error(message.error.message));
              else response?.resolve(message.result);
            } else child.receive(message);
          },
          close: () => {
            childClosed = true;
            for (const response of responses.values()) response.reject(new ChildTargetDetached('Child frame detached'));
            child.close();
          },
        });
        void (async () => {
          await childSend('Fetch.enable', fetchOptions);
          await childSend('Target.setAutoAttach', attachOptions);
          await childSend('Runtime.runIfWaitingForDebugger');
        })().catch(block);
      }
    };
    return {
      receive,
      close: () => {
        redirects.clear();
        for (const child of children.values()) child.close();
        children.clear();
      },
    };
  };
  const root = endpoint((method, params) =>
    session.send(method as Parameters<typeof session.send>[0], params as never),
  );
  session.on('Fetch.requestPaused', params => root.receive({ method: 'Fetch.requestPaused', params }));
  session.on('Target.attachedToTarget', params => root.receive({ method: 'Target.attachedToTarget', params }));
  session.on('Target.receivedMessageFromTarget', params =>
    root.receive({ method: 'Target.receivedMessageFromTarget', params }),
  );
  session.on('Target.detachedFromTarget', params => root.receive({ method: 'Target.detachedFromTarget', params }));
  await session.send('Fetch.enable', fetchOptions as never);
  await session.send('Target.setAutoAttach', attachOptions);

  return async () => {
    disposed = true;
    root.close();
    for (const reject of pending) reject(new Error('Navigation guard disposed'));
    await session.detach().catch(() => {});
  };
}
