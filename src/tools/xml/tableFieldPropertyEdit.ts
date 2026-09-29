/**
 * Field properties the C# bridge has no key for (AllowEdit, IgnoreEDTRelation), written
 * to the table XML. AllowEdit=No clears BPErrorTablePrimaryKeyEditable on staging key
 * fields; IgnoreEDTRelation=Yes clears BPErrorEDTNotMigrated on fields whose EDT has a relation.
 *
 * Sub-element order was measured over the fields of a real repo (no two files disagree):
 * a mis-ordered element is dropped by the deserializer without a word.
 */

import { escapeXml } from '../../utils/xmlEscape.js';

/** AxTableField child elements in serialised order, measured over ~225k shipped fields. */
export const FIELD_ELEMENT_ORDER = [
  'Name', 'AliasFor', 'AllowEdit', 'AllowEditOnCreate', 'AosAuthorization', 'AssetClassification',
  'ConfigurationKey', 'CountryRegionCodes', 'CountryRegionContextField', 'ExtendedDataType',
  'GeneralDataProtectionRegulation', 'FeatureClass', 'GroupPrompt', 'HelpText',
  'IgnoreEDTRelation', 'IsManuallyUpdated', 'IsObsolete', 'IsSystemGenerated', 'Label',
  'Mandatory', 'RelationContext', 'SaveContents', 'Null', 'Visible', 'MinReadAccess',
  'SysSharingType', 'StringSize', 'Tags', 'CorrectionFlagField', 'Scale', 'EnumType',
  'RelatedTable', 'FieldUpdate', 'CurrencyCode', 'CurrencyCodeField', 'CurrencyCodeTable',
  'CurrencyDate', 'CurrencyDateField', 'CurrencyDateTable'
] as const;

/** The properties this module writes. */
export const TABLE_FIELD_EDITABLE_PROPERTIES: readonly string[] = ['AllowEdit', 'IgnoreEDTRelation'];

export interface FieldEditResult {
  ok: boolean;
  xml?: string;
  message: string;
}

/** true/"yes" → Yes, false/"no" → No, anything else → undefined. */
export const yesNo = (v: unknown): 'Yes' | 'No' | undefined => {
  if (v === true || (typeof v === 'string' && /^(yes|true)$/i.test(v.trim()))) return 'Yes';
  if (v === false || (typeof v === 'string' && /^(no|false)$/i.test(v.trim()))) return 'No';
  return undefined;
};

/** Set (or insert in canonical position) one property of one field of an AxTable / AxTableExtension. */
export function upsertTableFieldProperty(
  xml: string,
  fieldName: string,
  prop: string,
  value: string,
): FieldEditResult {
  const canonical = TABLE_FIELD_EDITABLE_PROPERTIES.find(p => p.toLowerCase() === prop.toLowerCase());
  if (!canonical) {
    return { ok: false, message: `'${prop}' is not a field property this writer sets (${TABLE_FIELD_EDITABLE_PROPERTIES.join(', ')}).` };
  }
  const v = yesNo(value);
  if (!v) return { ok: false, message: `${canonical} takes Yes or No, not '${value}'.` };

  const esc = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const field = new RegExp(
    `^(\\t\\t<AxTableField\\b[^>]*>\\n)((?:\\t\\t\\t[^\\n]*\\n)*?\\t\\t\\t<Name>${esc}</Name>\\n(?:\\t\\t\\t[^\\n]*\\n)*?)(\\t\\t</AxTableField\\w*>)`,
    'm',
  ).exec(xml);
  if (!field) return { ok: false, message: `field '${fieldName}' not found in the table` };

  const body = field[2];
  const element = `\t\t\t<${canonical}>${escapeXml(v)}</${canonical}>\n`;
  const existing = new RegExp(`^\\t\\t\\t<${canonical}>[^<]*</${canonical}>\\n`, 'm');
  let newBody: string;
  if (existing.test(body)) {
    newBody = body.replace(existing, () => element);
  } else {
    const lines = body.split('\n');
    // An element outside the measured list ranks last, so a new property goes before it.
    const rank = (n: string) => {
      const i = FIELD_ELEMENT_ORDER.indexOf(n as never);
      return i >= 0 ? i : 999;
    };
    const mine = rank(canonical);
    let at = lines.length - 1; // default: after the last element (lines ends with '')
    for (let i = 0; i < lines.length; i++) {
      const m = /^\t\t\t<(\w+)[ />]/.exec(lines[i]);
      if (m && rank(m[1]) > mine) { at = i; break; }
    }
    lines.splice(at, 0, element.replace(/\n$/, ''));
    newBody = lines.join('\n');
  }
  const start = field.index + field[1].length;
  return {
    ok: true,
    xml: xml.slice(0, start) + newBody + xml.slice(start + body.length),
    message: `${fieldName}.${canonical}=${v}`,
  };
}

export interface FieldPropertyPatch { field: string; prop: string; value: string }

/**
 * The property patches a create's fields[] asks for: `allowEdit` and `ignoreEdtRelation`
 * (also accepted as `ignoreEDTRelation`), true/false or Yes/No.
 */
export function fieldPropertiesFromSpecs(specs: Array<Record<string, unknown>>): FieldPropertyPatch[] {
  const out: FieldPropertyPatch[] = [];
  for (const f of specs) {
    const name = typeof f?.name === 'string' ? f.name : undefined;
    if (!name) continue;
    const allowEdit = yesNo(f.allowEdit);
    if (allowEdit) out.push({ field: name, prop: 'AllowEdit', value: allowEdit });
    const ignore = yesNo(f.ignoreEdtRelation ?? f.ignoreEDTRelation);
    if (ignore) out.push({ field: name, prop: 'IgnoreEDTRelation', value: ignore });
  }
  return out;
}

/** Apply several patches; returns the new XML and the ones that could not be applied. */
export function applyFieldPropertyPatches(
  xml: string,
  patches: readonly FieldPropertyPatch[],
): { xml: string; applied: string[]; failed: string[] } {
  let current = xml;
  const applied: string[] = [];
  const failed: string[] = [];
  for (const p of patches) {
    const r = upsertTableFieldProperty(current, p.field, p.prop, p.value);
    if (r.ok) { current = r.xml!; applied.push(r.message); } else failed.push(`${p.field}.${p.prop}: ${r.message}`);
  }
  return { xml: current, applied, failed };
}
