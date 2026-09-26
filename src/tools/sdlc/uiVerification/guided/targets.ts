/// <reference lib="dom" />
import { createHash, randomUUID } from 'node:crypto';
import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import type { UiDiagnostic } from '../diagnostics.js';

export class GuidedBrowserError extends Error {
  constructor(
    public readonly code: 'NEEDS_OBSERVATION' | 'NOT_VERIFIED' | 'AUTH_REQUIRED' | 'CANCELLED',
    message: string,
    public readonly diagnostic?: UiDiagnostic,
  ) {
    super(message);
  }
}
export interface ObservedNode {
  ref: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  recommendedCheck?: 'value' | 'text' | 'checked';
}
interface AriaNode {
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  children?: AriaNode[];
  disabled?: boolean;
}
export interface ObservedTarget {
  handle: ElementHandle;
  scope?: ElementHandle;
  fingerprint: string;
  role: string;
  name: string;
  locator: Locator;
}
const stale = () =>
  new GuidedBrowserError(
    'NEEDS_OBSERVATION',
    'The observed target changed or is no longer available; request a fresh observation',
  );
export const passwordSelector =
  'input[type="password" i],input[autocomplete~="current-password" i],input[autocomplete~="new-password" i],input[autocomplete~="one-time-code" i]';

/** Compatibility adapter only: no private Playwright imports or inferred application selectors. */
function referenceLocator(page: Page, ariaRef: string): Locator {
  if (!/^[a-zA-Z0-9_-]+$/.test(ariaRef)) throw stale();
  return page.locator(`aria-ref=${ariaRef}`);
}
export async function fingerprint(handle: ElementHandle): Promise<string> {
  const identity = await handle.evaluate(element => {
    const el = element as HTMLElement;
    const row = el.closest('[role="row"],tr,[data-row-key],[data-record-id]');
    const attributes = (node: Element) =>
      Array.from(node.attributes)
        .filter(a =>
          /^(id|name|type|role|aria-label|aria-labelledby|aria-describedby|href|form|data-row-key|data-record-id|aria-rowindex)$/.test(
            a.name,
          ),
        )
        .map(a => [a.name, a.value]);
    const labels = (el as HTMLInputElement).labels;
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '');
    return {
      attached: el.isConnected,
      tag: el.tagName,
      attributes: attributes(el),
      text: el.innerText ?? el.textContent,
      labels: labels ? Array.from(labels).map(label => label.textContent) : [],
      labelledBy,
      row: row ? { attributes: attributes(row), text: (row as HTMLElement).innerText ?? row.textContent } : null,
    };
  });
  if (!identity.attached) throw stale();
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
async function inScope(handle: ElementHandle, scope: ElementHandle): Promise<boolean> {
  if (!(await scope.isVisible())) return false;
  const scopeFrame = await scope.ownerFrame();
  let frame = await handle.ownerFrame();
  if (!scopeFrame || !frame) return false;
  if (frame === scopeFrame) return handle.evaluate((element, parent) => parent.contains(element), scope);
  while (frame.parentFrame() && frame.parentFrame() !== scopeFrame) frame = frame.parentFrame()!;
  if (frame.parentFrame() !== scopeFrame) return false;
  const frameElement = await frame.frameElement();
  try {
    return await frameElement.evaluate((element, parent) => parent.contains(element), scope);
  } finally {
    await frameElement.dispose();
  }
}
export async function disposeTarget(target: ObservedTarget): Promise<void> {
  await target.handle.dispose().catch(() => {});
  await target.scope?.dispose().catch(() => {});
}
export async function validateTarget(target: ObservedTarget): Promise<ElementHandle> {
  try {
    if (
      (target.scope && !(await inScope(target.handle, target.scope))) ||
      !(await target.handle.isVisible()) ||
      (await fingerprint(target.handle)) !== target.fingerprint
    )
      throw stale();
    return target.handle;
  } catch {
    throw stale();
  }
}
export async function cloneTarget(target: ObservedTarget): Promise<ObservedTarget> {
  const copy = (await target.handle.evaluateHandle(element => element)).asElement();
  if (!copy) throw stale();
  const scope = target.scope
    ? ((await target.scope.evaluateHandle(element => element)).asElement() ?? undefined)
    : undefined;
  return { ...target, handle: copy, scope };
}
export async function companyText(handle: ElementHandle): Promise<string> {
  return handle.evaluate(element => {
    const el = element as HTMLElement;
    return (
      el.matches('input,textarea,select') ? (el as HTMLInputElement).value : (el.innerText ?? el.textContent ?? '')
    ).trim();
  });
}
export async function uniqueCompany(page: Page, target: ObservedTarget, company: string): Promise<void> {
  const handle = await validateTarget(target);
  if ((await companyText(handle)) !== company)
    throw new GuidedBrowserError('NOT_VERIFIED', 'The observed company does not match the requested company exactly');
  let matches = 0;
  for (const frame of page.frames()) {
    const locator =
      target.name && target.role !== 'generic' && target.role !== 'document'
        ? frame.getByRole(target.role as Parameters<Frame['getByRole']>[0], { name: target.name, exact: true })
        : frame.getByText(company, { exact: true });
    matches += await locator.filter({ visible: true }).count();
  }
  if (matches !== 1)
    throw new GuidedBrowserError('NOT_VERIFIED', 'The observed company must identify exactly one visible control');
}

/** Each observation publishes a fresh, bounded set of retained DOM identities. */
export class ObservedTargets {
  private targets = new Map<string, ObservedTarget>();
  private snapshotId = '';
  private documentGeneration = 0;
  private capturedGeneration = -1;
  private captureVersion = 0;
  constructor(private readonly page: Page) {
    page.on('framenavigated', () => {
      this.documentGeneration++;
    });
  }
  async invalidate(): Promise<void> {
    this.captureVersion++;
    this.snapshotId = '';
    const old = [...this.targets.values()];
    this.targets.clear();
    await Promise.all(old.map(disposeTarget));
  }
  async resolve(snapshotId: string, ref: string): Promise<ObservedTarget> {
    if (!snapshotId || snapshotId !== this.snapshotId || this.capturedGeneration !== this.documentGeneration)
      throw stale();
    const target = this.targets.get(ref);
    if (!target) throw stale();
    await validateTarget(target);
    return target;
  }
  async capture(
    options: { scopeRef?: string; filter?: string } = {},
    checkOperation: () => void = () => {},
    timeoutMs = 30000,
  ): Promise<{ snapshotId: string; nodes: ObservedNode[]; truncated: boolean }> {
    let scope: ObservedTarget | undefined;
    if (options.scopeRef) scope = await cloneTarget(await this.resolve(this.snapshotId, options.scopeRef));
    try {
      checkOperation();
      await this.invalidate();
    } catch (error) {
      if (scope) await disposeTarget(scope);
      throw error;
    }
    const version = this.captureVersion;
    const unpublished = new Map<string, ObservedTarget>();
    const check = () => {
      checkOperation();
      if (version !== this.captureVersion) throw stale();
    };
    const generation = this.documentGeneration;
    const snapshotId = randomUUID();
    const nodes: ObservedNode[] = [];
    let truncated = false;
    try {
      check();
      const locator = scope?.locator ?? this.page.locator('body');
      if (scope && !(await locator.evaluate((element, expected) => element === expected, scope.handle))) throw stale();
      check();
      const tree = (await locator.ariaSnapshotJSON({ mode: 'ai', timeout: timeoutMs })) as AriaNode[];
      check();
      const secrets: string[] = [];
      for (const frame of this.page.frames()) {
        check();
        secrets.push(
          ...(await frame
            .locator(passwordSelector)
            .evaluateAll(elements => elements.map(el => (el as HTMLInputElement).value).filter(Boolean))),
        );
      }
      const redact = (value: string | undefined) => {
        if (value === undefined) return undefined;
        for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
        if (value.length > 500) truncated = true;
        return value.slice(0, 500);
      };
      const candidates: AriaNode[] = [];
      const visit = (items: AriaNode[]) => {
        for (const item of items) {
          if (item.ref) candidates.push(item);
          if (item.children) visit(item.children);
        }
      };
      visit(tree);
      // An observed page/scope root supports deterministic visible:false checks.
      const rootHandle = scope
        ? (await scope.handle.evaluateHandle(el => el)).asElement()
        : await locator.elementHandle();
      if (rootHandle) {
        const ref = `r-${randomUUID()}`;
        const node = { ref, role: 'document', name: options.scopeRef ? 'Observed scope' : 'Page' };
        unpublished.set(ref, {
          handle: rootHandle,
          fingerprint: await fingerprint(rootHandle),
          role: node.role,
          name: node.name,
          locator,
        });
        nodes.push(node);
      }
      for (const raw of candidates) {
        check();
        if (
          options.filter &&
          !`${raw.role ?? ''} ${raw.name ?? ''} ${raw.text ?? ''}`.toLowerCase().includes(options.filter.toLowerCase())
        )
          continue;
        if (nodes.length >= 120) {
          truncated = true;
          break;
        }
        const targetLocator = referenceLocator(this.page, raw.ref!);
        if ((await targetLocator.count()) !== 1) continue;
        const handle = await targetLocator.elementHandle({ timeout: 1000 });
        if (!handle) continue;
        try {
          if (!(await handle.isVisible())) {
            await handle.dispose();
            continue;
          }
          const sensitive = await handle.evaluate((el, selector) => el.matches(selector), passwordSelector);
          const value = sensitive
            ? undefined
            : await handle.evaluate(el =>
                el.matches('input,textarea,select') ? (el as HTMLInputElement).value : undefined,
              );
          const ref = `r-${randomUUID()}`;
          const node: ObservedNode = { ref, role: raw.role ?? 'generic', name: redact(raw.name) ?? '' };
          if (raw.text !== undefined && !sensitive && value === undefined) node.text = redact(raw.text);
          if (value !== undefined) {
            node.value = redact(value);
            node.recommendedCheck = ['checkbox', 'radio'].includes(raw.role ?? '') ? 'checked' : 'value';
          }
          if (raw.disabled !== undefined) node.disabled = raw.disabled;
          if (JSON.stringify([...nodes, node]).length > 8000) {
            truncated = true;
            await handle.dispose();
            break;
          }
          unpublished.set(ref, {
            handle,
            scope: options.scopeRef ? (rootHandle ?? undefined) : undefined,
            fingerprint: await fingerprint(handle),
            role: raw.role ?? 'generic',
            name: raw.name ?? '',
            locator: targetLocator,
          });
          nodes.push(node);
        } catch (error) {
          await handle.dispose().catch(() => {});
          throw error;
        }
      }
      check();
      if (generation !== this.documentGeneration) throw stale();
      this.targets = unpublished;
      this.snapshotId = snapshotId;
      this.capturedGeneration = generation;
      return { snapshotId, nodes, truncated };
    } catch (error) {
      await Promise.all([...unpublished.values()].map(disposeTarget));
      if (error instanceof GuidedBrowserError) throw error;
      throw stale();
    } finally {
      if (scope) await disposeTarget(scope);
    }
  }
}
