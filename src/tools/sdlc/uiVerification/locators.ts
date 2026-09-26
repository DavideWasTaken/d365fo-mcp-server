import type { Locator, Page } from 'playwright';

/** CSS only; hidden duplicates never select a different active form implicitly. */
export async function visibleMatches(page: Page, selector: string, scope?: string): Promise<Locator> {
  const root = scope ? await uniqueVisible(page, scope) : page;
  return root.locator(`css=${selector}`).filter({ visible: true });
}

export async function uniqueVisible(page: Page, selector: string, scope?: string): Promise<Locator> {
  const locator = await visibleMatches(page, selector, scope);
  await locator.waitFor({ state: 'visible' });
  const count = await locator.count();
  if (count !== 1) throw new Error(`Selector must match exactly one visible element; observed ${count}: ${selector}`);
  return locator;
}
