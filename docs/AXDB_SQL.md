# Optional AxDB SQL tool

`axdb_sql` gives the agent **live SQL access to AxDB on a development VM**, for debugging: inspect persisted data, confirm what X++ code wrote, diagnose why a record has a particular value. It is off by default, and until SQL is configured the tool is not published at all — an installation that does not use it pays nothing for it, not even catalogue space.

## Configure only if needed

Setup offers SQL only where it can work: a **classic AOSService VM** whose `AosService\WebRoot\web.config` names the database its own AOS uses (`DataAccess.DbServer` / `DataAccess.Database`). There, after the environment type, the wizard asks whether to enable SQL on that server and database — answering no (the default) leaves SQL disabled; yes pre-fills both answers. On UDE (no local AxDB reachable with Windows authentication), or when no AOS web.config sits beside the packages folder, setup does not ask and says how to configure it by hand. Instance setup follows the same rule.

Configure or change it explicitly at any time, on any machine:

```powershell
d365fo-mcp config sql
```

From a git checkout, use `node dist/cli/index.js config sql` (the `doctor` and `update` commands print the exact command for the installation). Restart MCP after changes.

The questions are:

1. Server or named instance, such as `localhost` or `localhost\DEV` (offered from web.config when found). Leaving it empty disables SQL and skips the rest.
2. Database, normally `AxDB` (offered from web.config when found).
3. Whether to allow `INSERT`, `UPDATE` and `DELETE` in this database. Default: no.
4. Whether to trust the local SQL Server certificate. A developer VM's SQL Server presents a self-signed certificate, so the answer defaults to yes when the server is this machine (`.`, `localhost`, `(local)`, its name) and to no otherwise.

Authentication uses the **Windows account running the MCP/bridge process**. No SQL password or connection string is collected, stored or accepted in tool arguments. That account must have the required SQL permissions. The connection is encrypted; certificate validation is only relaxed if selected in setup. Connections open on demand, not at startup.

Example saved configuration for a developer VM where reads only and a self-signed certificate were selected:

```json
{
  "sql": {
    "enabled": true,
    "server": "localhost",
    "database": "AxDB",
    "allowWrites": false,
    "trustServerCertificate": true
  }
}
```

Advanced settings: `commandTimeoutSeconds` (1–30, default 30), `maxRows` (1–1000, default 100). Environment equivalents are listed in [CONFIGURATION.md](CONFIGURATION.md). Each instance has its own SQL settings: an explicitly set shell variable overrides the config, but another installation's ambient `.env` SQL settings do not leak into an instance.

## Build the updated bridge

SQL runs in the C# bridge, so it needs a bridge built from these sources on the Windows D365FO developer VM:

```powershell
npm run build
npm run bridge:build
dotnet build bridge/D365MetadataBridge -c Release
```

`bridge:build` verifies compilation in a scratch directory and refreshes the attestation; the final `dotnet build` updates the deployed binary (stop MCP first if that binary is locked), then restart MCP. ScriptDom is restored as a pinned NuGet dependency. An older bridge does not gain SQL support from a TypeScript-only build: the tool detects the missing capability and says how to rebuild it.

The tool is published in the `full` and `core` profiles, in the `full` and `write-only` server modes, once SQL is configured. It is excluded from `read-only` mode (Azure) because it needs the local bridge. Turning off `sql.allowWrites` permits queries while rejecting `execute`.

## When SQL is the right tool

| Work | Appropriate path |
|---|---|
| Diagnose why a record has a particular value; compare stored values | SQL query |
| Check what an X++ class or the application actually persisted | Run it, then an SQL query |
| Verify creation, field defaults, validation, CoC or a business workflow | Run it through the application or X++ — the code path is what is under test |
| Change a known development-only value to reproduce a bug | SQL `execute`, if writes were enabled |
| Create a complete business document with number sequences and relations | The application or X++, not invented SQL inserts |

Inserting a record with SQL does not prove that the code which should create it works. Direct SQL changes do not execute X++ validation or CoC, allocate number sequences or RecIds, or invalidate the AOS caches: a new SELECT sees committed database state, but the running application may keep serving cached values.

The agent decides when SQL is relevant from these rules and the tool contract; the tool itself does not interpret requirements. If SQL is not configured, the agent does not ask for it.

## Actions and examples

Fetch `{"action":"contract"}` for the full strict input schema, supported types, rules and examples.

- `status`: open a fresh connection and report the database and Windows identity actually reached.
- `schema`: columns, types, keys and defaults of a physical table.
- `query`: one SELECT, including CTEs, joins and aggregates.
- `execute`: up to 20 INSERT/UPDATE/DELETE statements in one local transaction, committed together; an optional `expectedRows` per statement rolls the batch back on mismatch.

```json
{
  "action": "query",
  "sql": "SELECT TOP (10) RECID, PURCHID FROM dbo.PURCHTABLE WHERE DATAAREAID=@company",
  "parameters": [{ "name": "company", "type": "nvarchar", "size": 4, "value": "USMF" }]
}
```

Use `schema` and the actual metadata before naming physical columns. Values are bound SQL parameters, named without `@` in JSON and referenced with `@` in SQL. `bigint`/RecId and `decimal` use strings to preserve precision; decimal requires precision/scale, nvarchar requires size. Include explicit `DATAAREAID` filters where applicable: SQL does not know the active company.

The read-only metadata functions `COLLATIONPROPERTY`, `DATABASEPROPERTYEX` and `DB_NAME` are supported, including `SELECT DATABASEPROPERTYEX(DB_NAME(), 'Collation')`. The two property functions return `sql_variant`, which comes back as the value's own type: the collation as text, `COLLATIONPROPERTY(..., 'CodePage')` as a number, and a `bigint`/`decimal` inside a variant as an exact string like any other. Qualified functions such as `dbo.DATABASEPROPERTYEX(...)` remain excluded ([DATABASEPROPERTYEX](https://learn.microsoft.com/en-us/sql/t-sql/functions/databasepropertyex-transact-sql), [COLLATIONPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/collation-functions-collationproperty-transact-sql)).

The tool supports local physical tables and SQL system catalog views. It excludes DDL, stored-procedure execution, dynamic SQL, transaction commands, cross-database references, SELECT INTO, user OUTPUT, query/table hints, user-defined functions, application views/synonyms and external tables. These restrictions are enforced on the parsed T-SQL syntax tree (ScriptDom), not guessed from the first word. Database permissions remain the authority; database triggers can have additional effects.

## Results and execution semantics

Every query executes again: **no result cache and no duplicate-call replay**. Output includes an operation ID, the target, the duration and the rows with their column types, or affected-row counts. Row and output limits mark incomplete results as `truncated`; the response always keeps whole JSON rows and the transaction status. Use narrow queries or COUNT/EXISTS instead of treating a partial result as complete.

There is no per-statement confirmation once writes are enabled, and no automatic write retry. `COMMITTED` means the batch committed; `ROLLED_BACK` means no batch changes remain; `UNKNOWN` means an interruption prevents determining the outcome, and the affected data must be inspected before another write. A SQL error is never reported as an empty successful result.

A transaction covers only its own statements on one SQL connection. The tool does not hold transactions open between calls, roll back work done by the AOS, or clean up data automatically.

## Verification

TypeScript tests cover the optional setup, instance isolation, the strict contract, no-cache/no-retry behavior and bounded JSON. The standalone C# host in [tests/axdb-sql-host](../tests/axdb-sql-host/README.md) covers the SQL policy, parameters and serialization without the D365 DLLs; its optional integration tests require an explicitly configured disposable SQL database, and its read-only smoke mode checks the real driver on a VM using `status` and constant SELECTs without reading business records. On a new installation, call `status` to confirm the configured database and Windows identity before issuing queries.
