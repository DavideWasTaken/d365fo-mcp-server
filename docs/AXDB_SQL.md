# Optional AxDB SQL tool

This fork adds `axdb_sql` for **live database debugging, persisted-data checks and targeted development data changes**. It is independent of `verify_ui_customization`; there are no automatic SQL setup/cleanup hooks in the UI runner.

## Configure only if needed

The normal `npm run setup` wizard and instance setup ask for a SQL server. **Leave it empty to disable SQL and skip all remaining SQL questions.** The disabled tool is not advertised to the agent and does not connect to a database. Revisit just this feature with:

```powershell
npx tsx src/cli/index.ts config sql
```

For an installed CLI use `d365fo-mcp config sql`. The command also supports selecting an instance through the normal config flow. Restart MCP after changes.

The guided steps are:

1. Server or named instance, such as `localhost` or `localhost\DEV`. No server is assumed if blank.
2. Database, normally `AxDB` on a developer VM.
3. Whether to allow `INSERT`, `UPDATE` and `DELETE` in this database.
4. Whether to trust the local SQL Server certificate (for developer self-signed certificates).

Authentication uses the **Windows account running the MCP/bridge process**. No SQL password is collected. That account must have the required SQL permissions. The connection is encrypted; certificate validation is only relaxed if selected in setup. Connections open on demand, not at startup.

Example saved configuration for a developer VM where writes and a self-signed certificate were selected:

```json
{
  "sql": {
    "enabled": true,
    "server": "localhost",
    "database": "AxDB",
    "allowWrites": true,
    "trustServerCertificate": true
  }
}
```

Advanced JSON settings: `commandTimeoutSeconds` (1–30, default 30), `maxRows` (1–1000, default 100). Environment equivalents are listed in [CONFIGURATION.md](CONFIGURATION.md). Each instance has its own SQL settings. An explicitly set shell variable overrides the config; an unrelated installation's ambient `.env` SQL settings do not leak into an instance.

## Build the updated bridge

Use this fork locally on the Windows D365FO developer VM. After updating source and installing dependencies:

```powershell
npm run build
npm run bridge:build
npm run bridge:attest
dotnet build bridge/D365MetadataBridge -c Release
```

Bridge compilation requires the D365FO development assemblies and a compatible .NET SDK (see [SETUP.md](SETUP.md)). `bridge:build` verifies compilation in a scratch directory and refreshes the attestation; the final `dotnet build` updates the deployed binary (stop MCP first if that binary is locked), then restart MCP. ScriptDom is restored as a pinned NuGet dependency. An older bridge does not gain SQL support merely by rebuilding TypeScript: the tool detects its missing capability and reports how to rebuild it. No database password or connection string is placed in tool arguments.

The tool is available in core/full profiles in full/write-only server modes when SQL is configured. It is excluded from read-only server mode because it includes mutations. Turning off `sql.allowWrites` permits queries while rejecting `execute`.

## Choose SQL according to the requirement

| Work | Appropriate path |
|---|---|
| Diagnose why a record has a particular value; compare stored values | SQL query |
| Check that a UI save persisted the expected data | UI action, then optional SQL query |
| Verify creation, field defaults, validation, CoC or a business workflow | Create/operate through UI or X++, including the path under test |
| Prepare unrelated prerequisites or change a known test-only value | SQL may help; explain why it does not bypass the requirement |
| Create a complete business document with number sequences and relations | Prefer UI/X++, not invented SQL inserts |

Do not seed all UI tests automatically. If the requirement is that the user can create an order, inserting that order through SQL does not test the requirement. SQL success cannot replace missing UI evidence. Direct SQL changes do not execute X++ validation/CoC, allocate business identifiers or invalidate application caches. A new SELECT sees committed database state, but a reopened browser does not guarantee that AOS caches have refreshed.

The agent decides when SQL is relevant using these rules; the tool itself does not interpret requirements. If SQL is disabled, continue with UI/X++ rather than interrupting every test to request SQL setup.

## Actions and examples

Fetch `{"action":"contract"}` for the full strict input schema, supported types and examples.

- `status`: open a fresh connection and report the database/identity actually reached.
- `schema`: inspect columns/types/keys/defaults of a physical table.
- `query`: one SELECT, including CTEs, joins and aggregates.
- `execute`: up to 20 INSERT/UPDATE/DELETE statements in one local transaction, committed together; optional `expectedRows` per statement causes rollback on mismatch.

Read-only metadata functions `COLLATIONPROPERTY`, `DATABASEPROPERTYEX` and `DB_NAME` are supported, including `SELECT DATABASEPROPERTYEX(DB_NAME(), 'Collation')`. Qualified custom functions such as `dbo.DATABASEPROPERTYEX(...)` remain excluded. This change is in the C# bridge: rebuild/deploy that bridge after pulling; a TypeScript-only build leaves the old SQL policy active. These functions read properties ([Microsoft DATABASEPROPERTYEX](https://learn.microsoft.com/en-us/sql/t-sql/functions/databasepropertyex-transact-sql), [Microsoft COLLATIONPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/collation-functions-collationproperty-transact-sql)); they do not enable writes.

```json
{
  "action": "query",
  "sql": "SELECT TOP (10) RECID, PURCHID FROM dbo.PURCHTABLE WHERE DATAAREAID=@company",
  "parameters": [{ "name": "company", "type": "nvarchar", "size": 4, "value": "USMF" }]
}
```

Use `schema` and the actual custom metadata before naming physical columns. Values are bound SQL parameters. Parameters are named without `@` in JSON and referenced with `@` in SQL. `bigint`/RecId and `decimal` use strings to preserve precision; decimal requires precision/scale, nvarchar requires size. Include explicit company filters where applicable; SQL does not inherit the active UI company. The SQL server/database and UI URL are separate configuration values: establish that they belong to the same environment before using SQL as UI test evidence.

The tool supports local physical tables and SQL system catalog views. It excludes DDL, stored-procedure execution, dynamic SQL, transaction commands, cross-database references, SELECT INTO, user OUTPUT, query/table hints, user-defined functions, application views/synonyms and external tables. These restrictions are parsed as T-SQL syntax rather than guessed from the first word. Database permissions remain the authority; database triggers can have additional effects.

## Results and execution semantics

Every query executes again: **no result cache or duplicate-call replay**. Output includes operation ID, target, duration and rows/column types or affected-row counts. Row and output limits mark incomplete results as `truncated`; the MCP response preserves whole JSON/rows and transaction status. Use narrow queries or COUNT/EXISTS for assertions instead of treating a partial result as complete evidence.

There is no per-statement confirmation after writes are enabled. There is also no automatic write retry. `COMMITTED` means the batch committed; `ROLLED_BACK` means no batch changes remain; `UNKNOWN` means an interruption prevents determining the outcome and the affected data must be inspected before another write. A SQL error is not an empty successful query result.

A transaction belongs to one SQL connection, not to the browser. The SQL tool does not roll back UI operations, auto-clean test data, or hold transactions open between MCP calls. If a test needs restoration, the agent must explicitly plan it and account for concurrent changes and uncertain writes.

## Verification

TypeScript tests cover optional setup, instance isolation, strict contracts, no-cache/no-retry behavior and bounded JSON. The standalone C# SQL host covers parser/parameters/serialization without D365 DLLs; optional integration tests require an explicitly configured disposable SQL fixture database. The maintainer has validated the SQL workflow on the development VM; see [validation status](TESTING.md#fork-validation-status). On a new installation, use `status` to confirm the configured database and Windows identity before issuing queries or writes.

For the SequentialAccess regression, [the SQL host's read-only smoke mode](../tests/axdb-sql-host/README.md#read-only-smoke-test-on-the-developer-vm) checks the real driver on your VM using `status` and constant SELECTs without modifying or reading business records. It covers text/binary streaming, NULL/empty values, mixed columns and size limits. After pulling a C# fix, rebuild/deploy the bridge and restart MCP; updating TypeScript alone leaves the old executable in use.
