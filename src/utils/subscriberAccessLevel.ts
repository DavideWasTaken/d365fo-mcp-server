/**
 * AxTable `SubscriberAccessLevel` — "Subscriber access level" in the Visual
 * Studio property sheet.
 *
 * Not a scalar like the rest of the property block: the metamodel type is
 * `AccessGrant`, six permissions each `Unset | Allow | Deny`, and the
 * serializer writes only the ones that are set, as child elements in
 * alphabetical order:
 *
 *   <SubscriberAccessLevel>
 *     <Read>Allow</Read>
 *   </SubscriberAccessLevel>
 *
 * All-Unset (the metamodel default) is written as no element at all.
 *
 * Visual Studio sets Read=Allow on every new regular table, and that is by far
 * the commonest value in shipped and partner metadata. Data entity staging
 * tables and TempDB/InMemory tables carry none. This server wrote none either,
 * and had no way to set one: the scalar property writer cannot express child
 * elements, and the name was not in the AxTable element order, so it was
 * dropped (issue #1073).
 */

/** The AccessGrant permissions, in the order the serializer writes them. */
export const SUBSCRIBER_PERMISSIONS = ['Correct', 'Create', 'Delete', 'Invoke', 'Read', 'Update'] as const;
export type SubscriberPermission = (typeof SUBSCRIBER_PERMISSIONS)[number];
export type SubscriberGrant = 'Allow' | 'Deny';
export type SubscriberAccessLevel = Partial<Record<SubscriberPermission, SubscriberGrant>>;

/** What Visual Studio writes on a new regular table. */
export const DEFAULT_SUBSCRIBER_ACCESS_LEVEL: SubscriberAccessLevel = { Read: 'Allow' };

export type ParsedSubscriberAccessLevel =
  | { ok: true; level: SubscriberAccessLevel }
  | { ok: false; error: string };

const USAGE =
  'Pass an object such as { "read": "Allow" } or { "read": "Allow", "create": "Deny" }, ' +
  'the same as a string "Read=Allow,Create=Deny", or "None" for no access level. ' +
  `Permissions: ${SUBSCRIBER_PERMISSIONS.join(', ')}; values: Allow, Deny, Unset.`;

function permissionOf(key: string): SubscriberPermission | undefined {
  return SUBSCRIBER_PERMISSIONS.find(p => p.toLowerCase() === key.trim().toLowerCase());
}

/** Allow / Deny, null for Unset (leave it out), undefined when not a valid value. */
function grantOf(raw: unknown): SubscriberGrant | null | undefined {
  if (raw === true) return 'Allow';
  if (raw === false) return 'Deny';
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'allow' || v === 'yes') return 'Allow';
  if (v === 'deny' || v === 'no') return 'Deny';
  if (v === 'unset' || v === '') return null;
  return undefined;
}

/**
 * A caller's `subscriberAccessLevel` value, in any of the accepted spellings.
 * An empty result means "no access level": the element is left out.
 */
export function parseSubscriberAccessLevel(raw: unknown): ParsedSubscriberAccessLevel {
  let entries: Array<[string, unknown]>;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^(none|unset)?$/i.test(s)) return { ok: true, level: {} };
    // A bare permission list ("Read" / "Read,Update") grants Allow, as the
    // property sheet's commonest setting does.
    entries = s
      .split(/[,;]/)
      .filter(p => p.trim())
      .map(p => {
        const [k, v] = p.split(/[=:]/);
        return [k, v === undefined ? 'Allow' : v];
      });
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    entries = Object.entries(raw as Record<string, unknown>);
  } else {
    return { ok: false, error: `Invalid subscriberAccessLevel ${JSON.stringify(raw)}. ${USAGE}` };
  }

  const level: SubscriberAccessLevel = {};
  for (const [key, value] of entries) {
    const permission = permissionOf(key);
    if (!permission) return { ok: false, error: `Unknown subscriber permission '${key.trim()}'. ${USAGE}` };
    const grant = grantOf(value);
    if (grant === undefined) {
      return {
        ok: false,
        error: `Invalid value ${JSON.stringify(value)} for subscriber permission ${permission}. ${USAGE}`,
      };
    }
    if (grant) level[permission] = grant;
    else delete level[permission];
  }
  return { ok: true, level };
}

/**
 * A modify-property / bridge value: the parse of a "Read=Allow,…" string, a
 * JSON object string, or an object, and the "Read=Allow,Create=Deny" / "None"
 * text the bridge's property setter reads.
 */
export function subscriberAccessLevelValue(
  raw: unknown,
): { ok: true; level: SubscriberAccessLevel; bridgeText: string } | { ok: false; error: string } {
  let value = raw;
  if (typeof raw === 'string' && /^\s*\{/.test(raw)) {
    try { value = JSON.parse(raw); } catch { /* reported as invalid by the parse */ }
  }
  const parsed = parseSubscriberAccessLevel(value);
  if (!parsed.ok) return parsed;
  const set = SUBSCRIBER_PERMISSIONS.filter(p => parsed.level[p]).map(p => `${p}=${parsed.level[p]}`);
  return { ok: true, level: parsed.level, bridgeText: set.length > 0 ? set.join(',') : 'None' };
}

/**
 * The `<SubscriberAccessLevel>` element at `indent`, children one level deeper.
 * '' for an empty level — the serializer writes nothing for all-Unset.
 */
export function renderSubscriberAccessLevel(level: SubscriberAccessLevel, indent = '\t'): string {
  const children = SUBSCRIBER_PERMISSIONS.filter(p => level[p]).map(p => `${indent}\t<${p}>${level[p]}</${p}>`);
  if (children.length === 0) return '';
  return `${indent}<SubscriberAccessLevel>\n${children.join('\n')}\n${indent}</SubscriberAccessLevel>`;
}

/** The table-level `<SubscriberAccessLevel>` element, with its line. */
const TABLE_LEVEL_ELEMENT =
  /^([ \t]*)<SubscriberAccessLevel\s*\/>[ \t]*\r?\n?|^([ \t]*)<SubscriberAccessLevel>[\s\S]*?<\/SubscriberAccessLevel>[ \t]*\r?\n?/m;

/**
 * Where the table's own property block ends: the first collection element.
 * An access level further down belongs to something else in the table.
 */
function propertyBlockEnd(xml: string): number {
  const m = /^[ \t]*<(DeleteActions|FieldGroups|Fields|FullTextIndexes|Indexes|Mappings|Relations|StateMachines)[\s/>]/m.exec(
    xml,
  );
  return m ? m.index : xml.length;
}

/** The access level an AxTable document declares ({} when it has none). */
export function readSubscriberAccessLevel(xml: string): SubscriberAccessLevel {
  const m = /<SubscriberAccessLevel>([\s\S]*?)<\/SubscriberAccessLevel>/.exec(xml.slice(0, propertyBlockEnd(xml)));
  const level: SubscriberAccessLevel = {};
  if (!m) return level;
  for (const p of SUBSCRIBER_PERMISSIONS) {
    const v = new RegExp(`<${p}>\\s*(Allow|Deny)\\s*</${p}>`).exec(m[1])?.[1];
    if (v === 'Allow' || v === 'Deny') level[p] = v;
  }
  return level;
}

export function sameSubscriberAccessLevel(a: SubscriberAccessLevel, b: SubscriberAccessLevel): boolean {
  return SUBSCRIBER_PERMISSIONS.every(p => a[p] === b[p]);
}

/** "Read=Allow, Create=Deny", or "none". */
export function describeSubscriberAccessLevel(level: SubscriberAccessLevel): string {
  const parts = SUBSCRIBER_PERMISSIONS.filter(p => level[p]).map(p => `${p}=${level[p]}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** Whether an AxTable document is a TempDB / InMemory table, which carries no access level. */
export function isTempAxTable(xml: string): boolean {
  return /<TableType>\s*(TempDB|InMemory)\s*<\/TableType>/i.test(xml);
}

/**
 * The access level a NEW table gets: the caller's, when one was passed and is
 * valid; otherwise Visual Studio's Read=Allow, or none for a TempDB/InMemory
 * table. Undefined for an invalid value, which the create reconcile reports.
 */
export function tableSubscriberAccessLevel(requested: unknown, tableType: unknown): SubscriberAccessLevel | undefined {
  if (requested !== undefined && requested !== null) {
    const parsed = parseSubscriberAccessLevel(requested);
    return parsed.ok ? parsed.level : undefined;
  }
  return /^(TempDB|InMemory)$/i.test(String(tableType ?? '').trim()) ? {} : { ...DEFAULT_SUBSCRIBER_ACCESS_LEVEL };
}

/**
 * Write `level` as the AxTable's access level, replacing any existing one, or
 * remove it when `level` is empty. `insertBefore` names the elements that must
 * follow it, in order; the first one present is the anchor. Null when there is
 * nothing to anchor on (not an AxTable property block).
 */
export function setSubscriberAccessLevel(
  xml: string,
  level: SubscriberAccessLevel,
  insertBefore: readonly string[],
): string | null {
  if (!/<AxTable[\s>]/.test(xml)) return null;
  const eol = /\r\n/.test(xml) ? '\r\n' : '\n';
  const existing = TABLE_LEVEL_ELEMENT.exec(xml.slice(0, propertyBlockEnd(xml)));
  if (existing) {
    const rendered = renderSubscriberAccessLevel(level, existing[1] ?? existing[2] ?? '\t');
    const replacement = rendered ? rendered.replace(/\n/g, eol) + eol : '';
    return xml.slice(0, existing.index) + replacement + xml.slice(existing.index + existing[0].length);
  }
  if (!renderSubscriberAccessLevel(level)) return xml;
  for (const candidate of insertBefore) {
    const m = new RegExp(`^([ \\t]*)<${candidate}(\\s*/>|[\\s>])`, 'm').exec(xml);
    if (!m) continue;
    const rendered = renderSubscriberAccessLevel(level, m[1] || '\t').replace(/\n/g, eol);
    return xml.slice(0, m.index) + rendered + eol + xml.slice(m.index);
  }
  return null;
}
