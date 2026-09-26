import type { ElementHandle, Locator } from 'playwright';

/** A malformed assertion is a test setup problem, never a business failure. */
export class CheckNotApplicable extends Error {
  readonly code = 'CHECK_NOT_APPLICABLE';
}

export async function assertCheckApplicable(target: ElementHandle | Locator, check: string): Promise<void> {
  if (!['text', 'value', 'checked'].includes(check)) return;
  const readControl = (node: Node) => {
    const element = node as Element;
    const nativeValue = element.matches('input,textarea,select');
    const nativeCheck = element.matches('input[type="checkbox" i],input[type="radio" i]');
    const role = element.getAttribute('role') ?? '';
    const ariaChecked = element.getAttribute('aria-checked');
    const ariaCheck = [
      'checkbox',
      'menuitemcheckbox',
      'option',
      'radio',
      'switch',
      'menuitemradio',
      'treeitem',
    ].includes(role);
    return {
      nativeValue,
      tag: element.tagName.toLowerCase(),
      checked: nativeCheck || ariaCheck,
      mixed: nativeCheck
        ? (element as HTMLInputElement).indeterminate
        : ariaCheck && !['true', 'false'].includes(ariaChecked ?? ''),
    };
  };
  const control = 'asElement' in target ? await target.evaluate(readControl) : await target.evaluate(readControl);
  if (check === 'text' && control.nativeValue)
    throw new CheckNotApplicable(
      'check="text" cannot read a native input, textarea or select value. Use check="value" in the mission, or bind this text criterion to an actual text element. Do not replay prior writes.',
    );
  if (check === 'value' && !control.nativeValue)
    throw new CheckNotApplicable(
      'check="value" requires the actual input, textarea or select, not its label/container. Bind the native field or use check="text" for displayed element text.',
    );
  if (check === 'checked' && (!control.checked || control.mixed))
    throw new CheckNotApplicable(
      'check="checked" requires a native checkbox/radio or a checkable ARIA control with an explicit true/false state. Missing or mixed states cannot be measured as boolean false.',
    );
}
