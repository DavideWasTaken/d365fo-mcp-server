import { z } from 'zod';

const sql = z.string().trim().min(1).max(50000);
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const fields = { name };
export const SqlParameterSchema = z.discriminatedUnion('type', [
  z.object({ ...fields, type: z.literal('bit'), value: z.boolean().nullable() }).strict(),
  z.object({ ...fields, type: z.literal('int'), value: z.number().int().min(-2147483648).max(2147483647).nullable() }).strict(),
  z.object({ ...fields, type: z.literal('bigint'), value: z.string().regex(/^-?\d{1,19}$/).nullable() }).strict(),
  z.object({ ...fields, type: z.literal('decimal'), value: z.string().regex(/^-?\d+(\.\d+)?$/).max(50).nullable(), precision: z.number().int().min(1).max(38), scale: z.number().int().min(0).max(38) }).strict(),
  z.object({ ...fields, type: z.literal('nvarchar'), value: z.string().max(16000).nullable(), size: z.union([z.literal(-1), z.number().int().min(1).max(4000)]) }).strict(),
  z.object({ ...fields, type: z.literal('uniqueidentifier'), value: z.guid().nullable() }).strict(),
  z.object({ ...fields, type: z.literal('date'), value: z.iso.date().nullable() }).strict(),
  z.object({ ...fields, type: z.literal('datetime2'), value: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/).nullable() }).strict(),
]);
const parameters = z.array(SqlParameterSchema).max(100).refine(values =>
  new Set(values.map(p => p.name.toLowerCase())).size === values.length, 'Parameter names must be unique').optional();
export const SqlInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('contract') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('schema'), table: name, schema: name.optional() }).strict(),
  z.object({ action: z.literal('query'), sql, parameters, maxRows: z.number().int().min(1).max(1000).optional() }).strict(),
  z.object({ action: z.literal('execute'), statements: z.array(z.object({ sql, parameters, expectedRows: z.number().int().nonnegative().max(2147483647).optional() }).strict()).min(1).max(20) }).strict(),
]);

export function sqlContract() {
  return {
    inputSchema: z.toJSONSchema(SqlInputSchema),
    rules: [
      'Optional local Windows bridge SQL tool. Blank/disabled SQL setup means do not use it. Configure with d365fo-mcp config sql and restart MCP.',
      'Use SQL to debug: inspect persisted data, confirm what X++ code wrote, diagnose. Prefer reads; write only for an explicitly useful, targeted development data change.',
      'Creating records, defaults, validation, CoC and business workflows must run through the application or X++. A row inserted with SQL does not prove that code path works.',
      'Direct SQL writes bypass X++ business logic, CoC, number sequences and application cache invalidation. Never invent RecId values for business records; create them through the application or X++.',
      'No result caching. Every call reads SQL Server again. No automatic retries for execute; UNKNOWN requires inspection, never an automatic second write.',
      'Use action=schema for actual SQL columns/types. Parameterize values; identifiers must be grounded in metadata/schema. Include explicit DATAAREAID filters for company-specific data; shared tables differ.',
      'query accepts one SELECT (joins, CTEs, aggregates). execute accepts up to 20 INSERT/UPDATE/DELETE statements committed together; expectedRows mismatch rolls back the batch.',
      'SQL policy excludes DDL, EXEC, dynamic SQL, transaction control, cross-database names, SELECT INTO, user OUTPUT, hints, UDFs, views/synonyms and external tables (sys catalog views are supported). SQL permissions still apply.',
      'Use bigint and decimal strings to preserve precision. Decimal requires precision/scale; nvarchar requires size. datetime2 is an ISO local datetime without offset. NULL requires an explicit type.',
      'Query limits: default from setup, at most 1000 returned rows and 256 KiB result. Truncated output is not complete evidence; use COUNT or specific columns/keys.',
      'A SQL transaction covers only its own statements, never work done by the AOS. There is no automatic setup, cleanup or rollback of application writes.',
    ],
    examples: [
      { action: 'query', sql: 'SELECT TOP (10) RECID, PURCHID FROM dbo.PURCHTABLE WHERE DATAAREAID=@company', parameters: [{ name: 'company', type: 'nvarchar', size: 4, value: 'USMF' }] },
      { action: 'execute', statements: [{ sql: 'UPDATE dbo.MyTestTable SET TestValue=@value WHERE RECID=@id', parameters: [{ name: 'value', type: 'nvarchar', size: 30, value: 'test' }, { name: 'id', type: 'bigint', value: '123' }], expectedRows: 1 }] },
    ],
  };
}
