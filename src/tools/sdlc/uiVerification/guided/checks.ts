import type { ElementHandle, Frame, Page } from 'playwright';
import type { Criterion, GuidedInput } from './contract.js';
import { assertCheckApplicable } from '../checkApplicability.js';
import { measureGridRows } from './gridRows.js';

type CheckInput = Extract<GuidedInput, { action: 'check' }>;
const credentialSelector =
  'input[type="password"], [autocomplete~="current-password" i], [autocomplete~="new-password" i], [autocomplete~="one-time-code" i]';
async function inComposedScope(scope: ElementHandle, candidate: ElementHandle): Promise<boolean> {
  return scope.evaluate((root, node) => {
    let current: Node | null = node;
    while (current) {
      if (root.contains(current)) return true;
      const tree = current.getRootNode();
      current = tree instanceof ShadowRoot ? tree.host : null;
    }
    return false;
  }, candidate);
}
async function countVisibleInScope(
  page: Page,
  scope: ElementHandle,
  query: NonNullable<CheckInput['absent']>,
): Promise<number> {
  const owner = await scope.ownerFrame();
  if (!owner) throw new Error('Scope frame is no longer available');
  let frameTreeChanged = false;
  const changed = () => {
    frameTreeChanged = true;
  };
  page.on('frameattached', changed);
  page.on('framedetached', changed);
  page.on('framenavigated', changed);
  let matched = 0;
  let candidates = 0;
  let frames = 0;
  try {
    const visit = async (frame: Frame): Promise<void> => {
      if (++frames > 100) throw new Error('Absence scope contains too many frames to verify completely');
      const locator = frame.getByRole(query.role, { name: query.name, exact: true });
      const count = await locator.count();
      candidates += count;
      if (candidates > 1000) throw new Error('Absence query is too large to verify completely');
      const handles = await locator.elementHandles();
      try {
        // If the query changed during enumeration, this was not a complete observation.
        if (handles.length !== count) throw new Error('Absence query changed while being observed');
        for (const candidate of handles)
          if ((frame !== owner || (await inComposedScope(scope, candidate))) && (await candidate.isVisible()))
            matched++;
      } finally {
        await Promise.all(handles.map(handle => handle.dispose()));
      }
      for (const child of frame.childFrames()) {
        const embedding = await child.frameElement();
        try {
          if ((frame !== owner || (await inComposedScope(scope, embedding))) && (await embedding.isVisible()))
            await visit(child);
        } finally {
          await embedding.dispose();
        }
      }
    };
    await visit(owner);
    if (frameTreeChanged || !(await scope.evaluate(node => node.isConnected)))
      throw new Error('Scope or frame tree changed during absence check');
    return matched;
  } finally {
    page.off('frameattached', changed);
    page.off('framedetached', changed);
    page.off('framenavigated', changed);
  }
}
export async function measureCheck(
  page: Page,
  resolve: (snapshot: string, ref: string) => Promise<ElementHandle>,
  criterion: Criterion,
  input: CheckInput,
): Promise<{ actual: string | boolean | number; passed: boolean; target: string }> {
  if ('kind' in criterion) throw new Error('AI review requires captured evidence and a declared AI criterion');
  let actual: string | boolean | number;
  if (input.absent) {
    if (criterion.check !== 'visible' || criterion.expected !== false)
      throw new Error('Absence query only allowed for visible:false criteria');
    const scope = await resolve(input.snapshotId!, input.absent.scopeRef);
    // Search the complete visible subtree, including descendant frame documents and shadow roots.
    const matched = await countVisibleInScope(page, scope, input.absent);
    actual = matched > 0;
    return {
      actual,
      passed: actual === criterion.expected,
      target: `Complete observed scope ${input.absent.scopeRef}: role=${input.absent.role}, exact name=${input.absent.name}; count=${matched}`,
    };
  }
  const element = await resolve(input.snapshotId!, input.ref!);
  if (await element.evaluate((node, selector) => node instanceof Element && node.matches(selector), credentialSelector))
    throw new Error('Sensitive credential controls cannot be checked');
  await assertCheckApplicable(element, criterion.check);
  if (criterion.check === 'rowCount') {
    const actual = await measureGridRows(element, criterion.basis);
    return {
      actual,
      passed: actual === criterion.expected,
      target: `Observed grid ref ${input.ref}; ${criterion.basis} data rows (column headers excluded)`,
    };
  }
  switch (criterion.check) {
    case 'visible':
      actual = await element.isVisible();
      break;
    case 'enabled':
      actual = await element.isEnabled();
      break;
    case 'checked':
      actual = await element.isChecked();
      break;
    case 'value':
      actual = await element.inputValue();
      break;
    case 'text':
      actual = (await element.innerText()).trim();
      break;
  }
  const passed =
    criterion.check === 'text' && criterion.match === 'contains'
      ? String(actual).includes(criterion.expected)
      : actual === criterion.expected;
  if (typeof actual === 'string') {
    // A normal text node can echo a password or OTP; the same redaction as an observation
    // must also apply to measured evidence. Evaluate the criterion before redaction.
    for (const frame of page.frames()) {
      const secrets = await frame
        .locator(credentialSelector)
        .evaluateAll(nodes =>
          nodes.map(node => (node as HTMLInputElement).value).filter((value): value is string => !!value),
        );
      for (const secret of secrets) actual = actual.split(secret).join('[REDACTED]');
    }
  }
  return { actual, passed, target: `Observed ref ${input.ref}` };
}
