import type { ElementHandle, Page } from 'playwright';
import type { BrowserAction } from './contract.js';
import { allowedNavigationUrl } from '../navigation.js';

export async function preflightAction(
  _page: Page,
  element: ElementHandle | undefined,
  action: BrowserAction,
  baseUrl: string,
) {
  if (action.type === 'navigate') {
    allowedNavigationUrl(action.url, [new URL(baseUrl).origin], baseUrl);
    return;
  }
  if (!element || !(await element.isVisible())) throw new Error('Observed control is no longer visible');
  if (
    (await element.getAttribute('type')) === 'password' ||
    /(?:^|\s)(current-password|new-password|one-time-code)(?:\s|$)/i.test(
      (await element.getAttribute('autocomplete')) ?? '',
    )
  )
    throw new Error('Password entry requires the human login flow');
  if (action.type === 'wait' || action.type === 'scroll') return;
  if (!(await element.isEnabled())) throw new Error('Control is disabled');
  if (action.type === 'fill' && !(await element.isEditable())) throw new Error('Control is not editable');
  // Trial performs actionability checks without dispatching a click. No modifiers.
  await element.click({ trial: true, timeout: 1000 });
}
export async function dispatchAction(
  page: Page,
  element: ElementHandle | undefined,
  action: BrowserAction,
  baseUrl: string,
  timeout: number,
) {
  const e = element!;
  switch (action.type) {
    case 'navigate':
      await page.goto(allowedNavigationUrl(action.url, [new URL(baseUrl).origin], baseUrl), {
        timeout,
        waitUntil: 'domcontentloaded',
      });
      break;
    case 'click':
      await e.click({ timeout });
      break;
    case 'dblclick':
      await e.dblclick({ timeout });
      break;
    case 'fill':
      await e.fill(action.value, { timeout });
      break;
    case 'select':
      await e.selectOption(action.value, { timeout });
      break;
    case 'check':
      await e.check({ timeout });
      break;
    case 'uncheck':
      await e.uncheck({ timeout });
      break;
    case 'press':
      await e.press(action.key, { timeout });
      break;
    case 'scroll':
      await e.evaluate(
        (node, delta) => (node as HTMLElement).scrollBy({ top: delta, behavior: 'instant' }),
        action.deltaY,
      );
      break;
    case 'wait':
      await e.waitForElementState('visible', { timeout });
      break;
  }
}
