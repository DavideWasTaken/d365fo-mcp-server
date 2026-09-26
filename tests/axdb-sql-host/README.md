# Standalone AxDB SQL service checks

This net48 console host compiles the production SQL policy, models and service directly, without Dynamics assemblies. It never connects to SQL unless explicitly configured for the disposable live fixture.

```powershell
dotnet restore tests/axdb-sql-host/AxDbSqlHost.csproj --configfile bridge/D365MetadataBridge/NuGet.config
dotnet build tests/axdb-sql-host/AxDbSqlHost.csproj --no-restore
& tests/axdb-sql-host/bin/Debug/net48/AxDbSqlHost.exe
```

The ordinary run checks AST allow/reject cases, preflight validation, disabled SQL/writes, integrated encrypted connection defaults, exact bigint/decimal(38,s) serialization, explicit NULL, and parameter truncation/rounding rejection. It prints SKIP for live coverage. It uses the installed .NET Framework runtime; SDK 7 can compile this host. The full metadata bridge still needs its normal D365 binaries and SDK supporting its C#12 setting.

Aliases and CTE references should use the same letter casing as their declaration. Validation preserves exact identifier spelling so distinct objects on case-sensitive databases are never skipped by case-folded alias matches or catalog-check deduplication.

Schema query offline coverage parses the catalog SQL and checks the default/primary-key projections and parameter tokens. Actual catalog values are verified only by the opt-in live fixture: its `Id` column must report primary-key membership and ordinal, while `Note` must report its physical default definition. A skipped fixture is not evidence that those live catalog lookups executed.

For live checks, provision an empty **disposable** SQL Server database whose name starts with `CodexAxDbFixture_`. The current Windows identity needs table/trigger creation and read/write privileges there. Set these variables only for this test process:

```powershell
$env:D365FO_SQL_TEST_SERVER = '<fixture SQL Server>'
$env:D365FO_SQL_TEST_DATABASE = 'CodexAxDbFixture_local'
$env:D365FO_SQL_TEST_ALLOW_MUTATION = '1'
# Only for a fixture server using a locally trusted/self-signed certificate:
$env:D365FO_SQL_TEST_TRUST_CERTIFICATE = '1'
& tests/axdb-sql-host/bin/Debug/net48/AxDbSqlHost.exe
```

The host creates a uniquely named table and trigger inside that database and removes them in `finally`. It never creates/deletes databases and refuses database names outside the fixture prefix. Never configure it with a real AxDB. Live coverage includes commit, batch rollback on assertions and SQL errors, exact numeric round trips, schema inspection, row/byte limits, direct row counts with triggers, and a blocked-read timeout. Lost commit acknowledgement requires an external fault-injection SQL proxy and is not claimed as tested by this host.
