import type { Frame, Page } from 'playwright';

export interface DetectedSystemError {
  code: 'MENU_ITEM_OPEN_FAILED' | 'MULTIPLE_SYSTEM_ERRORS';
  message: string;
}
export interface SystemErrorEvidence extends DetectedSystemError {
  observedAt: string;
  stage: 'baseline' | 'after_action';
}
export interface SystemErrorInspection {
  complete: boolean;
  errors: DetectedSystemError[];
  reason?: string;
}
export interface SystemErrorRecord {
  systemErrors?: SystemErrorEvidence[];
  systemErrorInspectionIncomplete?: string;
}
const incomplete = (): SystemErrorInspection => ({
  complete: false,
  errors: [],
  reason: 'System-error inspection was unavailable, changed during inspection, or exceeded its bounds.',
});

/** Only inspect visible application DOM. Never return raw dialog text or credentials. */
export async function inspectSystemErrors(page: Page, origin: string): Promise<SystemErrorInspection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const changed = new Set<Frame>();
  const onNavigation = (frame: Frame) => changed.add(frame);
  page.on('framenavigated', onNavigation);
  page.on('frameattached', onNavigation);
  page.on('framedetached', onNavigation);
  const allowed = (frame: Frame): boolean => {
    try {
      if (new URL(frame.url()).origin === origin) return true;
      return (
        ['about:blank', 'about:srcdoc'].includes(frame.url()) && !!frame.parentFrame() && allowed(frame.parentFrame()!)
      );
    } catch {
      return false;
    }
  };
  try {
    return await Promise.race([
      new Promise<SystemErrorInspection>(resolve => {
        timer = setTimeout(() => {
          expired = true;
          resolve(incomplete());
        }, 2000);
      }),
      (async (): Promise<SystemErrorInspection> => {
        if (!allowed(page.mainFrame())) return incomplete();
        const frames = page.frames();
        let complete = frames.length <= 32;
        const errors = new Map<string, DetectedSystemError>();
        for (const frame of frames.slice(0, 32)) {
          if (expired) return incomplete();
          let visible = true;
          for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
            const host = await current.frameElement();
            try {
              if (
                !(await host.isVisible()) ||
                (await host.evaluate(el => {
                  for (let current: Element | null = el instanceof Element ? el : null; current; ) {
                    const style = getComputedStyle(current);
                    if (
                      current.getAttribute('aria-hidden') === 'true' ||
                      style.opacity === '0' ||
                      style.display === 'none' ||
                      style.visibility === 'hidden' ||
                      style.visibility === 'collapse'
                    )
                      return true;
                    current =
                      current.assignedSlot ??
                      current.parentElement ??
                      (current.getRootNode() instanceof ShadowRoot ? (current.getRootNode() as ShadowRoot).host : null);
                  }
                  return false;
                }))
              )
                visible = false;
            } finally {
              await host.dispose();
            }
            if (!visible) break;
          }
          if (!visible) continue;
          if (!allowed(frame)) {
            complete = false;
            continue;
          }
          const url = frame.url();
          const result = await frame.evaluate(() => {
            let complete = true;
            let elements = 0;
            let regions = 0;
            const codes = new Set<'MENU_ITEM_OPEN_FAILED' | 'MULTIPLE_SYSTEM_ERRORS'>();
            const visible = (el: Element): boolean => {
              for (let current: Element | null = el; current; ) {
                const style = getComputedStyle(current);
                if (
                  current.getAttribute('aria-hidden') === 'true' ||
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  style.visibility === 'collapse' ||
                  style.opacity === '0'
                )
                  return false;
                current =
                  current.assignedSlot ??
                  current.parentElement ??
                  (current.getRootNode() instanceof ShadowRoot ? (current.getRootNode() as ShadowRoot).host : null);
              }
              return el.getClientRects().length > 0 || getComputedStyle(el).display === 'contents';
            };
            const scan = (root: Document | ShadowRoot) => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node: Node | null;
              while ((node = walker.nextNode())) {
                if (++elements > 20000) {
                  complete = false;
                  return;
                }
                const el = node as Element;
                if (el.shadowRoot) scan(el.shadowRoot);
                if (
                  !el.matches('[role="dialog"],[role="alertdialog"],[role="alert"],[aria-modal="true"],dialog[open]') ||
                  !visible(el)
                )
                  continue;
                if (++regions > 32) {
                  complete = false;
                  return;
                }
                let text = '';
                let count = 0;
                const visited = new Set<Node>();
                const readText = (part: Node, depth: number) => {
                  if (visited.has(part)) return;
                  visited.add(part);
                  if (++count > 10000 || text.length > 16000 || depth > 100) {
                    complete = false;
                    return;
                  }
                  if (part.nodeType === Node.TEXT_NODE) {
                    const range = document.createRange();
                    range.selectNodeContents(part);
                    if (range.getClientRects().length) text += ' ' + (part.textContent ?? '').slice(0, 16001);
                    if (text.length > 16000) complete = false;
                    return;
                  }
                  if (
                    part instanceof Element &&
                    (!visible(part) || part.matches('script,style,input,textarea,[contenteditable="true"]'))
                  )
                    return;
                  const children = part instanceof HTMLSlotElement ? part.assignedNodes({ flatten: true }) : [];
                  const nodes = children.length
                    ? children
                    : part instanceof Element && part.shadowRoot
                      ? part.shadowRoot.childNodes
                      : part.childNodes;
                  for (const child of nodes) {
                    readText(child, depth + 1);
                    if (count > 10000 || text.length > 16000) break;
                  }
                };
                readText(el, 0);
                text = text.slice(0, 16000).replace(/\s+/g, ' ').trim();
                if (
                  /(?:unable to open (?:the )?menu item|cannot open (?:the )?menu item|impossibile aprire (?:l['’]oggetto )?menu item)/iu.test(
                    text,
                  )
                )
                  codes.add('MENU_ITEM_OPEN_FAILED');
                if (/(?:multiple errors (?:received|occurred)|più errori ricevuti)/iu.test(text))
                  codes.add('MULTIPLE_SYSTEM_ERRORS');
              }
            };
            scan(document);
            return { complete, codes: [...codes] };
          });
          // Discard evidence if navigation raced the read, including same-URL reloads.
          if (
            expired ||
            frame.url() !== url ||
            changed.has(frame) ||
            changed.has(page.mainFrame()) ||
            !allowed(frame)
          ) {
            complete = false;
            continue;
          }
          complete &&= result.complete;
          for (const code of result.codes)
            errors.set(code, {
              code,
              message:
                code === 'MENU_ITEM_OPEN_FAILED'
                  ? 'D365 could not open the requested menu item.'
                  : 'D365 displayed a multiple-system-errors dialog.',
            });
        }
        if (changed.size || page.frames().length !== frames.length || !allowed(page.mainFrame())) complete = false;
        return { complete, errors: [...errors.values()], ...(complete ? {} : { reason: incomplete().reason }) };
      })().catch(() => incomplete()),
    ]);
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
    page.off('framenavigated', onNavigation);
    page.off('frameattached', onNavigation);
    page.off('framedetached', onNavigation);
  }
}

export function retainSystemErrors(
  target: SystemErrorRecord,
  inspection: SystemErrorInspection,
  dispatched: boolean,
): SystemErrorEvidence[] {
  if (!inspection.complete) target.systemErrorInspectionIncomplete ??= incomplete().reason;
  const added: SystemErrorEvidence[] = [];
  for (const error of inspection.errors) {
    if (target.systemErrors?.some(previous => previous.code === error.code)) continue;
    const evidence = {
      ...error,
      observedAt: new Date().toISOString(),
      stage: dispatched ? ('after_action' as const) : ('baseline' as const),
    };
    (target.systemErrors ??= []).push(evidence);
    added.push(evidence);
  }
  return added;
}
