import type { ElementHandle } from 'playwright';
import { CheckNotApplicable } from '../checkApplicability.js';

/** Count a bound grid, never infer the dataset size from a virtualized viewport. */
export async function measureGridRows(element: ElementHandle, basis: 'rendered' | 'total'): Promise<number> {
  const result = await element.evaluate((node, source) => {
    const root = node as Element;
    const gridSelector = '[role="grid"],[role="treegrid"],[role="table"],table';
    if (!root.matches(gridSelector)) return { error: 'target' };
    if (root.closest('[aria-busy="true"]') || root.querySelector('[aria-busy="true"]')) return { error: 'busy' };
    if (root.hasAttribute('aria-owns') || root.querySelector('[aria-owns]')) return { error: 'ownership' };
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = root;
    let inspected = 0;
    while (current) {
      const el = current as Element;
      if (++inspected > 20000) return { error: 'size' };
      if (el.shadowRoot || el.matches('iframe,frame,slot') || el.localName.includes('-')) return { error: 'boundary' };
      current = walk.nextNode();
    }
    const nodes = Array.from(root.querySelectorAll('[role="row"],tr'));
    if (nodes.length > 2000) return { error: 'size' };
    const rows = nodes.filter(row => row.closest(gridSelector) === root);
    const visible = (node: Element) => {
      const style = getComputedStyle(node);
      return (
        !node.closest('[aria-hidden="true"]') &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)
      );
    };
    const classified = rows.map(row => {
      const cells = Array.from(
        row.querySelectorAll('[role="columnheader"],[role="gridcell"],[role="cell"],[role="rowheader"],td,th'),
      ).filter(cell => cell.closest('[role="row"],tr') === row && cell.closest(gridSelector) === root);
      const isHeader = (cell: Element) =>
        cell.getAttribute('role') === 'columnheader' ||
        (cell.tagName === 'TH' && cell.getAttribute('scope') !== 'row' && cell.getAttribute('role') !== 'rowheader');
      const header = cells.length > 0 && cells.every(isHeader);
      const data = cells.length > 0 && cells.every(cell => !isHeader(cell));
      return {
        row,
        header,
        data,
        visible: visible(row) || cells.some(visible),
        index: row.getAttribute('aria-rowindex'),
      };
    });
    if (classified.some(r => (source === 'total' || r.visible) && !r.header && !r.data)) return { error: 'structure' };
    if (source === 'rendered') return { count: classified.filter(r => r.data && r.visible).length };
    const rawTotal = root.getAttribute('aria-rowcount');
    if (rawTotal === null || !/^\d+$/.test(rawTotal)) return { error: 'total' };
    const total = Number(rawTotal);
    if (!Number.isSafeInteger(total) || total > 1_000_000 || total < rows.length) return { error: 'total' };
    if (total === 0) return { count: 0 };
    // ARIA counts include header rows. Require consistent indices and evidence of
    // the leading header section before subtracting it from the declared total.
    const indices = classified.map(r => (r.index && /^[1-9]\d*$/.test(r.index) ? Number(r.index) : NaN));
    if (indices.some(i => !Number.isSafeInteger(i) || i > total) || new Set(indices).size !== indices.length)
      return { error: 'indices' };
    const headers = classified
      .filter(r => r.header)
      .map(r => Number(r.index))
      .sort((a, b) => a - b);
    if (headers.some((index, i) => index !== i + 1) || (!headers.length && !indices.includes(1)))
      return { error: 'headers' };
    if (total > headers.length && !classified.some(r => r.data && Number(r.index) === headers.length + 1))
      return { error: 'headers' };
    return { count: total - headers.length };
  }, basis);
  const reasons: Record<string, string> = {
    target: 'rowCount requires the observed grid/table itself, not a row, title or surrounding form.',
    busy: 'The grid is marked aria-busy. Observe again after loading finishes; no count was compared.',
    ownership: 'Externally owned ARIA rows cannot be enumerated reliably by this grid check.',
    boundary:
      'Grid rows cross an unsupported shadow/custom-element or embedded-frame boundary. Bind an observed inner standard grid, or measure its explicit empty-result alert.',
    size: 'The grid exceeds the bounded row inspection limit; no complete count is available.',
    structure: 'Grid rows do not expose unambiguous header or data cells; no count was compared.',
    total:
      'A total count requires a consistent non-negative aria-rowcount. Rendered rows alone cannot prove an empty dataset. Use a measured empty-result alert when available.',
    indices: 'Total count metadata has missing, duplicate or inconsistent aria-rowindex values.',
    headers:
      'Total count lacks a complete leading header section and first data-row boundary. Observe the top of the grid; cannot safely subtract headers from aria-rowcount.',
  };
  if (result.error) throw new CheckNotApplicable(reasons[result.error]);
  return result.count!;
}
