/**
 * In-place edits of an existing AxDataEntityView (pure string in / string out).
 *
 * The bridge writes a fixed list of entity properties and cannot add a datasource or a
 * mapped field to an entity (only to an extension), so these edits are made here.
 *
 * Element order matters: the deserializer drops a mis-ordered element silently, and an
 * element missing from the order table lets a new property land on the wrong side of it.
 */

import { escapeXml } from '../../utils/xmlEscape.js';
import { buildAxDataEntityViewFieldXml } from './dataEntityViewExtensionXml.js';
import { yesNo } from './tableFieldPropertyEdit.js';

/**
 * Top-level elements of an AxDataEntityView in serialised order, measured over the ~5,800
 * shipped entities of a platform install (pairwise majority; a handful of outliers exist).
 */
export const ENTITY_TOP_LEVEL_ORDER = [
  'Name', 'SourceCode', 'ConfigurationKey', 'CountryRegionCodes', 'DeveloperDocumentation',
  'FormRef', 'IsObsolete', 'Label', 'SingularLabel', 'OperationalDomain', 'SubscriberAccessLevel',
  'Tags', 'AllowArchival', 'AllowRetention', 'AllowRowVersionChangeTracking',
  'AutoCreateDataverse', 'DataManagementEnabled', 'DataManagementStagingTable',
  'EnableSetBasedSqlOperations', 'EntityCategory', 'IsPublic', 'IsReadOnly', 'Modules',
  'PrimaryCompanyContext', 'PrimaryKey', 'PublicCollectionName', 'PublicEntityName',
  'SupportsSetBasedSqlOperations', 'ValidTimeStateEnabled', 'DeleteActions', 'FieldGroups',
  'Fields', 'Keys', 'Mappings', 'Ranges', 'Relations', 'StateMachines', 'ViewMetadata'
] as const;

/**
 * The scalar properties upsertDataEntityProperty writes. Modules, OperationalDomain and
 * SubscriberAccessLevel are ordered above but not writable here: their values are enums or
 * structures this writer does not validate.
 */
export const ENTITY_SCALAR_PROPERTIES: ReadonlySet<string> = new Set([
  'ConfigurationKey', 'CountryRegionCodes', 'DeveloperDocumentation', 'FormRef', 'IsObsolete',
  'Label', 'SingularLabel', 'Tags', 'AllowRowVersionChangeTracking', 'AutoCreateDataverse',
  'DataManagementEnabled', 'DataManagementStagingTable', 'AllowArchival', 'AllowRetention',
  'EnableSetBasedSqlOperations', 'EntityCategory', 'IsPublic', 'IsReadOnly',
  'PrimaryCompanyContext', 'PrimaryKey', 'PublicCollectionName', 'PublicEntityName',
  'SupportsSetBasedSqlOperations', 'ValidTimeStateEnabled',
]);

const ENTITY_NOYES_PROPERTIES: ReadonlySet<string> = new Set([
  'AllowArchival', 'AllowRetention', 'AllowRowVersionChangeTracking', 'AutoCreateDataverse',
  'DataManagementEnabled', 'EnableSetBasedSqlOperations', 'IsObsolete', 'IsPublic', 'IsReadOnly',
  'SupportsSetBasedSqlOperations', 'ValidTimeStateEnabled',
]);

export interface EditResult {
  ok: boolean;
  xml?: string;
  /** Human-readable reason when !ok, or a note when ok. */
  message: string;
}

const fail = (message: string): EditResult => ({ ok: false, message });

function isEntity(xml: string): boolean {
  return /<AxDataEntityView[\s>]/.test(xml);
}

/** Top-level (one tab) element lines, with their offsets. */
function topLevelElements(xml: string): Array<{ name: string; index: number }> {
  const out: Array<{ name: string; index: number }> = [];
  const re = /^\t<(\w+)(?:\s[^>]*)?(?:\/>|>)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ name: m[1], index: m.index });
  return out;
}

/**
 * Set (or insert, in canonical position) one scalar property of an entity.
 * Refuses names that are not entity scalar properties: writing an arbitrary
 * element would land somewhere the deserializer ignores.
 */
export function upsertDataEntityProperty(xml: string, name: string, value: string): EditResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  const canonical = [...ENTITY_SCALAR_PROPERTIES].find(p => p.toLowerCase() === name.toLowerCase());
  if (!canonical) {
    return fail(
      `'${name}' is not a scalar AxDataEntityView property. Supported: ` +
      `${[...ENTITY_SCALAR_PROPERTIES].join(', ')}.`,
    );
  }
  // A NoYes property written as anything else is dropped by the deserializer without a word.
  let written = value;
  if (ENTITY_NOYES_PROPERTIES.has(canonical)) {
    const v = yesNo(value);
    if (!v) return fail(`${canonical} takes Yes or No, not '${value}'.`);
    written = v;
  }
  const text = `<${canonical}>${escapeXml(written)}</${canonical}>`;

  // Existing element (leaf or empty): replace in place.
  const existing = new RegExp(`^\\t<${canonical}(?:>[^<]*</${canonical}>|\\s*/>)`, 'm');
  if (existing.test(xml)) {
    return { ok: true, xml: xml.replace(existing, () => `\t${text}`), message: `${canonical} updated` };
  }

  // Insert before the first top-level element that belongs AFTER this one.
  const rank = (n: string) => ENTITY_TOP_LEVEL_ORDER.indexOf(n as never);
  const mine = rank(canonical);
  const later = topLevelElements(xml).find(e => rank(e.name) > mine);
  if (!later) return fail('could not find an insertion point (no collections in the document)');
  return {
    ok: true,
    xml: `${xml.slice(0, later.index)}\t${text}\n${xml.slice(later.index)}`,
    message: `${canonical} inserted`,
  };
}

export interface EntityDataSourceSpec {
  name: string;
  table: string;
  /** Existing datasource to nest under. Default: the root datasource. */
  joinSource?: string;
  /** InnerJoin (default, omitted from XML) | OuterJoin | ExistsJoin | NoExistsJoin. */
  joinMode?: string;
  /** Field on the JOIN (parent) datasource. */
  joinField?: string;
  /** Field on the NEW datasource's table. */
  relatedField?: string;
  readOnly?: boolean;
  /** Default true — every shipped embedded datasource of an entity carries it. */
  dynamicFields?: boolean;
}

const JOIN_MODES = ['InnerJoin', 'OuterJoin', 'ExistsJoin', 'NoExistsJoin'];

/**
 * Add an AxQuerySimpleEmbeddedDataSource, with its join relation, under a
 * datasource of the entity's ViewMetadata query.
 *
 * Shape and sub-element order come from a shipped entity:
 *   Name, DynamicFields, IsReadOnly, Table, DataSources, DerivedDataSources,
 *   Fields, Ranges, JoinMode, Relations
 * On the relation, `Field` is the field of the JOIN (parent) datasource and
 * `RelatedField` the field of the new datasource's table
 * (DefaultDimension → DimensionSetEntity.RecId).
 */
export function addDataEntityDataSource(xml: string, spec: EntityDataSourceSpec): EditResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  if (!spec.joinField || !spec.relatedField) {
    return fail(
      'an embedded datasource needs its join relation: pass joinField (field on the parent ' +
      'datasource) and relatedField (field on the new datasource\'s table) — a datasource with no ' +
      'relation is a cross join.',
    );
  }
  const joinMode = spec.joinMode
    ? JOIN_MODES.find(m => m.toLowerCase() === spec.joinMode!.toLowerCase())
    : undefined;
  if (spec.joinMode && !joinMode) {
    return fail(`joinMode '${spec.joinMode}' is not one of ${JOIN_MODES.join(', ')}.`);
  }

  const vm = xml.indexOf('<ViewMetadata>');
  if (vm < 0) return fail('the entity has no <ViewMetadata> query (it is an inert skeleton)');
  const query = xml.slice(vm);

  const dsElement = /^(\t+)<(AxQuerySimpleRootDataSource|AxQuerySimpleEmbeddedDataSource)>\n\t+<Name>([^<]+)<\/Name>/gm;
  const sources: Array<{ name: string; indent: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = dsElement.exec(query))) sources.push({ name: m[3], indent: m[1], index: vm + m.index });
  if (sources.length === 0) return fail('the entity query has no datasource');
  if (sources.some(s => s.name === spec.name)) {
    return fail(`datasource '${spec.name}' already exists on this entity`);
  }

  const root = sources.find(s => s.indent === '\t\t\t') ?? sources[0];
  const parent = spec.joinSource ? sources.find(s => s.name === spec.joinSource) : root;
  if (!parent) {
    return fail(`joinSource '${spec.joinSource}' is not a datasource of this entity (have: ${sources.map(s => s.name).join(', ')}).`);
  }

  // The parent's OWN <DataSources>, found by exact indentation so a nested one is never taken.
  const pi = parent.indent;
  const childIndent = `${pi}\t\t`;
  const after = xml.slice(parent.index);
  const own = new RegExp(`^${pi}\\t<DataSources(?: />|>)`, 'm').exec(after);
  if (!own) return fail(`could not find the <DataSources> of '${parent.name}'`);
  const ownAt = parent.index + own.index;

  const t = (n: number) => '\t'.repeat(n);
  const depth = childIndent.length; // tabs
  const lines = [
    `${t(depth)}<AxQuerySimpleEmbeddedDataSource>`,
    `${t(depth + 1)}<Name>${escapeXml(spec.name)}</Name>`,
    ...(spec.dynamicFields === false ? [] : [`${t(depth + 1)}<DynamicFields>Yes</DynamicFields>`]),
    ...(spec.readOnly ? [`${t(depth + 1)}<IsReadOnly>Yes</IsReadOnly>`] : []),
    `${t(depth + 1)}<Table>${escapeXml(spec.table)}</Table>`,
    `${t(depth + 1)}<DataSources />`,
    `${t(depth + 1)}<DerivedDataSources />`,
    `${t(depth + 1)}<Fields />`,
    `${t(depth + 1)}<Ranges />`,
    ...(joinMode && joinMode !== 'InnerJoin' ? [`${t(depth + 1)}<JoinMode>${joinMode}</JoinMode>`] : []),
    `${t(depth + 1)}<Relations>`,
    `${t(depth + 2)}<AxQuerySimpleDataSourceRelation>`,
    `${t(depth + 3)}<Name>QueryDataSourceRelation1</Name>`,
    `${t(depth + 3)}<Field>${escapeXml(spec.joinField)}</Field>`,
    `${t(depth + 3)}<JoinDataSource>${escapeXml(parent.name)}</JoinDataSource>`,
    `${t(depth + 3)}<RelatedField>${escapeXml(spec.relatedField)}</RelatedField>`,
    `${t(depth + 2)}</AxQuerySimpleDataSourceRelation>`,
    `${t(depth + 1)}</Relations>`,
    `${t(depth)}</AxQuerySimpleEmbeddedDataSource>`,
  ].join('\n');

  const openLen = own[0].length;
  let updated: string;
  if (own[0].endsWith('/>')) {
    updated =
      `${xml.slice(0, ownAt)}${pi}\t<DataSources>\n${lines}\n${pi}\t</DataSources>` +
      `${xml.slice(ownAt + openLen)}`;
  } else {
    const closeRe = new RegExp(`^${pi}\\t</DataSources>`, 'm');
    const rest = xml.slice(ownAt + openLen);
    const close = closeRe.exec(rest);
    if (!close) return fail(`unbalanced <DataSources> under '${parent.name}'`);
    const at = ownAt + openLen + close.index;
    updated = `${xml.slice(0, at)}${lines}\n${xml.slice(at)}`;
  }
  return { ok: true, xml: updated, message: `datasource ${spec.name} added under ${parent.name}` };
}

export interface EntityMappedFieldSpec {
  name: string;
  dataField: string;
  dataSource: string;
  label?: string;
  accessModifier?: string;
  mandatory?: string;
}

/** Append one AxDataEntityViewMappedField to the entity's top-level <Fields>. */
export function addDataEntityMappedField(xml: string, spec: EntityMappedFieldSpec): EditResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`<AxDataEntityViewField\\b[^>]*>\\s*<Name>${esc}</Name>`).test(xml)) {
    return fail(`field '${spec.name}' already exists on this entity`);
  }
  const element = buildAxDataEntityViewFieldXml({
    name: spec.name, dataField: spec.dataField, dataSource: spec.dataSource,
    label: spec.label, accessModifier: spec.accessModifier, mandatory: spec.mandatory,
  });
  const empty = /^\t<Fields \/>/m.exec(xml);
  if (empty) {
    return {
      ok: true,
      xml: `${xml.slice(0, empty.index)}\t<Fields>\n${element}\n\t</Fields>${xml.slice(empty.index + empty[0].length)}`,
      message: `field ${spec.name} added`,
    };
  }
  const open = /^\t<Fields>\n/m.exec(xml);
  if (!open) return fail('the entity has no top-level <Fields> collection');
  const close = /^\t<\/Fields>/m.exec(xml.slice(open.index));
  if (!close) return fail('unbalanced <Fields>');
  const at = open.index + close.index;
  return { ok: true, xml: `${xml.slice(0, at)}${element}\n${xml.slice(at)}`, message: `field ${spec.name} added` };
}
