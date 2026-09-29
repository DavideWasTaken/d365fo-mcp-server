/**
 * Editing an existing AxDataEntityView in place: entity properties inserted in canonical
 * order, an outer-joined embedded datasource, and a mapped field.
 */
import { describe, it, expect } from 'vitest';
import {
  upsertDataEntityProperty,
  addDataEntityDataSource,
  addDataEntityMappedField,
} from '../../src/tools/xml/dataEntityViewEdit';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';

const base = () => buildAxDataEntityXml('ContosoThingEntity', {
  label: '@X:Y', primaryTable: 'AssetTrans', dynamicFields: true,
  fields: [{ name: 'AssetId' }, { name: 'DefaultDimension' }], isReadOnly: true,
});
const order = (xml: string) => [...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1]);

describe('upsertDataEntityProperty', () => {
  it('inserts PrimaryCompanyContext between IsPublic and PrimaryKey', () => {
    const r = upsertDataEntityProperty(base(), 'PrimaryCompanyContext', 'DataAreaId');
    expect(r.ok).toBe(true);
    const o = order(r.xml!);
    expect(o.indexOf('PrimaryCompanyContext')).toBe(o.indexOf('IsPublic') + 1 + (o.includes('IsReadOnly') ? 1 : 0));
    expect(o.indexOf('PrimaryCompanyContext')).toBeLessThan(o.indexOf('PrimaryKey'));
    expect(r.xml).toContain('<PrimaryCompanyContext>DataAreaId</PrimaryCompanyContext>');
  });
  it('inserts ConfigurationKey before Label (after SourceCode)', () => {
    const r = upsertDataEntityProperty(base(), 'ConfigurationKey', 'Asset');
    const o = order(r.xml!);
    expect(o.indexOf('ConfigurationKey')).toBeLessThan(o.indexOf('Label'));
    expect(o.indexOf('ConfigurationKey')).toBeGreaterThan(o.indexOf('Name'));
  });
  it('replaces an existing value instead of duplicating', () => {
    const once = upsertDataEntityProperty(base(), 'ConfigurationKey', 'Asset').xml!;
    const twice = upsertDataEntityProperty(once, 'ConfigurationKey', 'Ledger');
    expect(twice.xml!.match(/<ConfigurationKey>/g)).toHaveLength(1);
    expect(twice.xml).toContain('<ConfigurationKey>Ledger</ConfigurationKey>');
  });
  it('refuses a property that is not an AxDataEntityView property', () => {
    expect(upsertDataEntityProperty(base(), 'Bogus', 'x').ok).toBe(false);
  });
  it('refuses a non-entity document', () => {
    expect(upsertDataEntityProperty('<AxTable><Name>T</Name></AxTable>', 'ConfigurationKey', 'A').ok).toBe(false);
  });
});

describe('addDataEntityDataSource', () => {
  it('adds an outer-joined embedded datasource under the root with a relation', () => {
    const r = addDataEntityDataSource(base(), {
      name: 'DefaultDimensionDAVS', table: 'DimensionSetEntity', joinMode: 'OuterJoin',
      joinField: 'DefaultDimension', relatedField: 'RecId', readOnly: true,
    });
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('<AxQuerySimpleEmbeddedDataSource>');
    expect(r.xml).toMatch(/<Name>DefaultDimensionDAVS<\/Name>\s*<DynamicFields>Yes<\/DynamicFields>\s*<IsReadOnly>Yes<\/IsReadOnly>\s*<Table>DimensionSetEntity<\/Table>/);
    expect(r.xml).toContain('<JoinMode>OuterJoin</JoinMode>');
    expect(r.xml).toMatch(/<Field>DefaultDimension<\/Field>\s*<JoinDataSource>AssetTrans<\/JoinDataSource>\s*<RelatedField>RecId<\/RelatedField>/);
    // nested inside the root datasource's own <DataSources>, not the ViewMetadata one
    expect(r.xml).toMatch(/<AxQuerySimpleRootDataSource>[\s\S]*<DataSources>\s*<AxQuerySimpleEmbeddedDataSource>/);
  });
  it('a second datasource is appended, and a duplicate name is refused', () => {
    const a = addDataEntityDataSource(base(), { name: 'A', table: 'T1', joinField: 'F', relatedField: 'RecId' });
    const b = addDataEntityDataSource(a.xml!, { name: 'B', table: 'T2', joinField: 'G', relatedField: 'RecId' });
    expect(b.xml!.match(/<AxQuerySimpleEmbeddedDataSource>/g)).toHaveLength(2);
    expect(addDataEntityDataSource(b.xml!, { name: 'A', table: 'T1', joinField: 'F', relatedField: 'RecId' }).ok).toBe(false);
  });
  it('refuses an unknown join parent and a missing relation', () => {
    expect(addDataEntityDataSource(base(), { name: 'A', table: 'T', joinSource: 'Nope', joinField: 'F', relatedField: 'R' }).ok).toBe(false);
    expect(addDataEntityDataSource(base(), { name: 'A', table: 'T' }).ok).toBe(false);
  });
});

describe('addDataEntityMappedField', () => {
  it('appends an AxDataEntityViewMappedField bound to a datasource', () => {
    const r = addDataEntityMappedField(base(), {
      name: 'DefaultDimensionDisplayValue', dataField: 'DisplayValue', dataSource: 'DefaultDimensionDAVS',
    });
    expect(r.ok).toBe(true);
    expect(r.xml).toMatch(/<Name>DefaultDimensionDisplayValue<\/Name>\s*<DataField>DisplayValue<\/DataField>\s*<DataSource>DefaultDimensionDAVS<\/DataSource>/);
  });
  it('is idempotent on the field name', () => {
    const a = addDataEntityMappedField(base(), { name: 'X', dataField: 'F', dataSource: 'AssetTrans' });
    expect(addDataEntityMappedField(a.xml!, { name: 'X', dataField: 'F', dataSource: 'AssetTrans' }).ok).toBe(false);
  });
});
