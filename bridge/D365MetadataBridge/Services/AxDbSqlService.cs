using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Data.SqlTypes;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using D365MetadataBridge.Models;

namespace D365MetadataBridge.Services
{
    /// <summary>Lazy, fresh SQL debug operations. No connection on construction and no retry of any operation.</summary>
    public sealed class AxDbSqlService
    {
        public const int ResponseByteLimit = 256 * 1024;
        private const string SchemaSql = @"SELECT c.column_id AS ordinal, c.name AS name, t.name AS type,
c.max_length AS maxLength, c.precision AS precision, c.scale AS scale, c.is_nullable AS isNullable,
c.is_identity AS isIdentity, c.is_computed AS isComputed, dc.definition AS defaultDefinition,
CONVERT(bit, CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END) AS isPrimaryKey,
pk.key_ordinal AS primaryKeyOrdinal
FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id
JOIN sys.objects o ON c.object_id=o.object_id JOIN sys.schemas s ON o.schema_id=s.schema_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id=dc.object_id
LEFT JOIN (
    SELECT ic.object_id, ic.column_id, ic.key_ordinal
    FROM sys.index_columns ic JOIN sys.indexes i ON ic.object_id=i.object_id AND ic.index_id=i.index_id
    WHERE i.is_primary_key=1 AND ic.key_ordinal>0
) pk ON c.object_id=pk.object_id AND c.column_id=pk.column_id
WHERE s.name=@schema AND o.name=@table ORDER BY c.column_id";
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        private readonly AxDbSqlOptions options;
        public bool Enabled => options.Enabled;

        public AxDbSqlService(AxDbSqlOptions options) { this.options = options; }

        public async Task<Dictionary<string, object?>> Handle(string method, JsonElement? input)
        {
            var watch = Stopwatch.StartNew();
            var result = new Dictionary<string, object?>
            {
                ["operationId"] = Guid.NewGuid().ToString("D"), ["server"] = options.Server,
                ["database"] = options.Database, ["durationMs"] = 0L, ["success"] = false
            };
            var write = string.Equals(method, "axdbExecute", StringComparison.OrdinalIgnoreCase);
            var statements = new List<Dictionary<string, object?>>();
            if (write) { result["transactionState"] = "ROLLED_BACK"; result["statements"] = statements; }
            SqlConnection? connection = null;
            // Explicit SQL transaction commands allow cancellation/timeouts on BEGIN and COMMIT too.
            // SqlConnection.BeginTransaction/SqlTransaction.Commit have no async cancellation overload in net48.
            bool transactionStarted = false;
            bool commitAttempted = false;
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45)))
            {
                try
                {
                    if (!Enabled) throw new AxDbFailure("AXDB_UNAVAILABLE", "AxDB SQL is disabled. Configure D365FO_SQL_ENABLED and D365FO_SQL_SERVER, then restart the server with an updated bridge.");
                    if (write && !options.AllowWrites) throw new AxDbFailure("AXDB_WRITES_DISABLED", "Enable D365FO_SQL_ALLOW_WRITES to execute SQL changes.");
                    var request = input.HasValue ? JsonSerializer.Deserialize<AxDbSqlRequest>(input.Value.GetRawText(), Json) : new AxDbSqlRequest();
                    if (request == null) throw new ArgumentException("SQL request must be an object.");
                    var normalized = method.ToLowerInvariant();
                    var planned = new List<PlannedStatement>();
                    if (normalized == "axdbquery") planned.Add(Plan(request, false));
                    if (write)
                    {
                        if (request.Statements == null || request.Statements.Count < 1 || request.Statements.Count > 20)
                            throw new ArgumentException("execute requires 1..20 statements.");
                        foreach (var statement in request.Statements)
                        {
                            if (statement == null || statement.ExpectedRows < 0) throw new ArgumentException("expectedRows must be a non-negative integer.");
                            planned.Add(Plan(statement, true));
                        }
                    }
                    if (normalized == "axdbschema")
                    {
                        if (string.IsNullOrWhiteSpace(request.Table) || request.Table.Length > 128 || string.IsNullOrWhiteSpace(request.Schema) || request.Schema.Length > 128)
                            throw new ArgumentException("schema and table must be non-empty identifiers of at most 128 characters.");
                    }
                    var maxRows = request.MaxRows ?? options.MaxRows;
                    if (maxRows < 1 || maxRows > 1000) throw new ArgumentException("maxRows must be 1..1000.");
                    connection = new SqlConnection(options.ConnectionString());
                    await connection.OpenAsync(deadline.Token).ConfigureAwait(false);
                    using (var init = Command(connection, null, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET XACT_ABORT ON; SET NOCOUNT ON; SET LOCK_TIMEOUT 30000;", watch))
                        await init.ExecuteNonQueryAsync(deadline.Token).ConfigureAwait(false);
                    if (normalized == "axdbstatus")
                    {
                        using (var command = Command(connection, null, "SELECT DB_NAME() AS databaseName, SUSER_SNAME() AS loginName, CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS serverName", watch))
                            await Read(command, result, 1, deadline.Token).ConfigureAwait(false);
                        result["available"] = true; result["allowWrites"] = options.AllowWrites;
                        result["timeoutSeconds"] = options.TimeoutSeconds; result["maxRows"] = options.MaxRows;
                    }
                    else if (normalized == "axdbschema")
                    {
                        await CheckTables(connection, null, new[] { new AxDbTableReference { Schema = request.Schema, Table = request.Table } }, watch, deadline.Token).ConfigureAwait(false);
                        using (var command = Command(connection, null, SchemaSql, watch))
                        {
                            command.Parameters.Add("@schema", SqlDbType.NVarChar, 128).Value = request.Schema;
                            command.Parameters.Add("@table", SqlDbType.NVarChar, 128).Value = request.Table;
                            await Read(command, result, 1000, deadline.Token).ConfigureAwait(false);
                        }
                    }
                    else if (normalized == "axdbquery")
                    {
                        await CheckTables(connection, null, planned[0].Tables, watch, deadline.Token).ConfigureAwait(false);
                        using (var command = Command(connection, null, request.Sql, watch))
                        {
                            command.Parameters.AddRange(planned[0].Parameters);
                            await Read(command, result, maxRows, deadline.Token).ConfigureAwait(false);
                        }
                    }
                    else if (write)
                    {
                        using (var begin = Command(connection, null, "BEGIN TRANSACTION;", watch))
                            await begin.ExecuteNonQueryAsync(deadline.Token).ConfigureAwait(false);
                        transactionStarted = true;
                        for (var index = 0; index < planned.Count; index++)
                        {
                            result["failedStatementIndex"] = index;
                            var item = planned[index];
                            await CheckTables(connection, null, item.Tables, watch, deadline.Token).ConfigureAwait(false);
                            // @@ROWCOUNT is the count of the submitted DML, unlike ExecuteNonQuery's trigger-inclusive count.
                            using (var command = Command(connection, null, item.Request.Sql + "\n; SELECT CONVERT(bigint, @@ROWCOUNT) AS __axdb_affected_rows;", watch))
                            {
                                command.Parameters.AddRange(item.Parameters);
                                long? count = null;
                                using (var reader = await command.ExecuteReaderAsync(deadline.Token).ConfigureAwait(false))
                                {
                                    do
                                    {
                                        while (await reader.ReadAsync(deadline.Token).ConfigureAwait(false))
                                            if (reader.FieldCount == 1 && reader.GetName(0) == "__axdb_affected_rows") count = reader.GetInt64(0);
                                    } while (await reader.NextResultAsync(deadline.Token).ConfigureAwait(false));
                                }
                                if (!count.HasValue) throw new AxDbFailure("AXDB_ROWCOUNT_UNAVAILABLE", "SQL did not return an affected-row count; batch rollback was requested.");
                                statements.Add(new Dictionary<string, object?> { ["rowsAffected"] = count.Value });
                                if (item.Request.ExpectedRows.HasValue && count.Value != item.Request.ExpectedRows.Value)
                                {
                                    result["expectedRows"] = item.Request.ExpectedRows.Value; result["actualRows"] = count.Value;
                                    throw new AxDbFailure("AXDB_EXPECTED_ROWS_MISMATCH", "Affected-row assertion failed; rollback of the entire batch was requested.");
                                }
                            }
                        }
                        deadline.Token.ThrowIfCancellationRequested();
                        result.Remove("failedStatementIndex");
                        using (var command = Command(connection, null, "COMMIT TRANSACTION;", watch))
                        {
                            commitAttempted = true;
                            await command.ExecuteNonQueryAsync(deadline.Token).ConfigureAwait(false);
                        }
                        result["transactionState"] = "COMMITTED";
                    }
                    else throw new ArgumentException("Unknown AxDB SQL operation.");
                    result["success"] = true;
                }
                catch (Exception exception)
                {
                    if (write && transactionStarted)
                    {
                        if (commitAttempted) result["transactionState"] = "UNKNOWN";
                        else
                        {
                            // Never claim a rollback when the server's acknowledgement was lost.
                            try
                            {
                                using (var rollback = new SqlCommand("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;", connection) { CommandTimeout = 2 })
                                    await rollback.ExecuteNonQueryAsync().ConfigureAwait(false);
                                result["transactionState"] = "ROLLED_BACK";
                            }
                            catch { result["transactionState"] = "UNKNOWN"; }
                        }
                    }
                    var code = exception is AxDbFailure failure ? failure.Code :
                        exception is OperationCanceledException || (exception is SqlException sql && sql.Number == -2) ? "AXDB_TIMEOUT" :
                        exception is SqlException ? "AXDB_SQL_ERROR" : "AXDB_INVALID_REQUEST";
                    if (commitAttempted) code = "AXDB_COMMIT_UNKNOWN";
                    var message = commitAttempted ? "Commit acknowledgement was lost. Outcome is UNKNOWN; verify database state before any further write. Do not replay this batch." : exception.Message;
                    if (!commitAttempted && write && Equals(result["transactionState"], "UNKNOWN"))
                        message += " Rollback acknowledgement was lost. Outcome is UNKNOWN; verify database state before any further write. Do not replay this batch.";
                    if (message.Length > 2048) message = message.Substring(0, 2048);
                    result["error"] = new { code, message };
                    // A failed read returns no partial dataset, including oversized column metadata.
                    if (!write) { result.Remove("columns"); result.Remove("rows"); result.Remove("truncated"); }
                    if (normalizedStatus(method)) result["available"] = false;
                }
                finally
                {
                    // Close immediately; no transparent retries, reconnects or operation replay.
                    try { connection?.Dispose(); } catch { }
                    result["durationMs"] = watch.ElapsedMilliseconds;
                }
            }
            return result;
        }

        private static bool normalizedStatus(string method) => string.Equals(method, "axdbStatus", StringComparison.OrdinalIgnoreCase);

        private PlannedStatement Plan(AxDbSqlRequest request, bool write)
        {
            var tables = AxDbSqlPolicy.Validate(request.Sql, write);
            var parameters = (request.Parameters ?? new List<AxDbSqlParameter>()).Select(p => p.ToSqlParameter()).ToArray();
            if (parameters.Length > 200 || parameters.Select(p => p.ParameterName).Distinct(StringComparer.OrdinalIgnoreCase).Count() != parameters.Length)
                throw new ArgumentException("At most 200 parameters with distinct names are supported.");
            return new PlannedStatement { Request = request, Tables = tables, Parameters = parameters };
        }

        private SqlCommand Command(SqlConnection connection, SqlTransaction? transaction, string sql, Stopwatch watch)
        {
            var remaining = 45 - watch.Elapsed.TotalSeconds;
            if (remaining <= 0) throw new OperationCanceledException("AxDB SQL operation exceeded its 45-second budget.");
            return new SqlCommand(sql, connection, transaction) { CommandTimeout = Math.Max(1, Math.Min(options.TimeoutSeconds, (int)Math.Ceiling(remaining))) };
        }

        private async Task CheckTables(SqlConnection connection, SqlTransaction? transaction, IEnumerable<AxDbTableReference> tables, Stopwatch watch, CancellationToken token)
        {
            foreach (var table in tables.GroupBy(t => t.Schema + "\0" + t.Table, StringComparer.Ordinal).Select(g => g.First()))
            {
                using (var command = Command(connection, transaction, @"SELECT o.type, o.is_ms_shipped,
CASE WHEN EXISTS (SELECT 1 FROM sys.external_tables e WHERE e.object_id=o.object_id) THEN 1 ELSE 0 END AS externalTable, s.name
FROM sys.all_objects o JOIN sys.schemas s ON o.schema_id=s.schema_id
WHERE (@schema='' AND o.object_id=OBJECT_ID(QUOTENAME(@table))) OR (s.name=@schema AND o.name=@table)", watch))
                {
                    command.Parameters.Add("@schema", SqlDbType.NVarChar, 128).Value = table.Schema;
                    command.Parameters.Add("@table", SqlDbType.NVarChar, 128).Value = table.Table;
                    using (var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false))
                    {
                        if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new ArgumentException("Local table not found or not visible: " + table.Schema + "." + table.Table);
                        var type = reader.GetString(0).Trim();
                        if (reader.GetInt32(2) != 0 || !(type == "U" || (reader.GetString(3).Equals("sys", StringComparison.OrdinalIgnoreCase) && reader.GetBoolean(1) && type == "V")))
                            throw new ArgumentException("Only local base tables and built-in sys catalog views are supported; views, synonyms and external tables are rejected: " + table.Schema + "." + table.Table);
                    }
                }
            }
        }

        private static async Task Read(SqlCommand command, Dictionary<string, object?> result, int maxRows, CancellationToken token)
        {
            var rows = new List<Dictionary<string, object?>>();
            var columns = new List<object>();
            result["columns"] = columns; result["rows"] = rows; result["truncated"] = false;
            using (var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false))
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    if (!names.Add(reader.GetName(i))) throw new ArgumentException("Duplicate result column names are unsupported; give columns unique aliases.");
                    columns.Add(new { name = reader.GetName(i), type = reader.GetDataTypeName(i) });
                }
                if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > ResponseByteLimit - 4096)
                    throw new ArgumentException("Result column metadata exceeds the response budget.");
                while (await reader.ReadAsync(token).ConfigureAwait(false))
                {
                    if (rows.Count == maxRows) { result["truncated"] = true; break; }
                    var row = new Dictionary<string, object?>();
                    for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = Cell(reader, i);
                    rows.Add(row);
                    if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > ResponseByteLimit - 4096)
                    { rows.RemoveAt(rows.Count - 1); result["truncated"] = true; break; }
                }
            }
        }

        public static object? ExactValue(object value)
        {
            if (value == DBNull.Value || value is INullable nullable && nullable.IsNull) return null;
            if (value is SqlDecimal decimalValue) return decimalValue.ToString();
            if (value is long number) return number.ToString(CultureInfo.InvariantCulture);
            if (value is decimal fixedNumber) return fixedNumber.ToString(CultureInfo.InvariantCulture);
            if (value is DateTime time) return time.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture);
            if (value is DateTimeOffset offset) return offset.ToString("o", CultureInfo.InvariantCulture);
            if (value is TimeSpan span) return span.ToString("c", CultureInfo.InvariantCulture);
            if (value is Guid guid) return guid.ToString("D");
            if (value is byte[] binary) return Convert.ToBase64String(binary);
            if (value is double floating && (double.IsInfinity(floating) || double.IsNaN(floating))) throw new ArgumentException("Non-finite SQL value is unsupported.");
            if (value is string || value is bool || value is byte || value is short || value is int || value is double || value is float) return value;
            throw new ArgumentException("Unsupported result type: " + value.GetType().Name);
        }

        private static object? Cell(SqlDataReader reader, int ordinal)
        {
            if (reader.IsDBNull(ordinal)) return null;
            var type = reader.GetDataTypeName(ordinal).ToLowerInvariant();
            // Avoid overflowing CLR decimal for SQL decimal(38,s).
            if (type == "decimal" || type == "numeric") return ExactValue(reader.GetSqlDecimal(ordinal));
            if (type == "nvarchar" || type == "varchar" || type == "nchar" || type == "char" || type == "ntext" || type == "text")
            {
                if (reader.GetChars(ordinal, 0, null, 0, 0) > ResponseByteLimit / 2) throw new AxDbFailure("AXDB_CELL_TOO_LARGE", "One SQL cell exceeds the response budget; select a smaller substring.");
            }
            if (type == "varbinary" || type == "binary" || type == "image")
                if (reader.GetBytes(ordinal, 0, null, 0, 0) > ResponseByteLimit / 2) throw new AxDbFailure("AXDB_CELL_TOO_LARGE", "One binary SQL cell exceeds the response budget.");
            if (!ScalarTypes.Contains(type)) throw new ArgumentException("Unsupported SQL result type: " + type + "; explicitly convert it to a supported scalar type.");
            return ExactValue(reader.GetValue(ordinal));
        }

        private static readonly HashSet<string> ScalarTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "bigint", "int", "smallint", "tinyint", "bit", "money", "smallmoney", "float", "real",
            "date", "datetime", "smalldatetime", "datetime2", "datetimeoffset", "time", "uniqueidentifier",
            "nvarchar", "varchar", "nchar", "char", "ntext", "text", "varbinary", "binary", "image", "timestamp", "rowversion"
        };

        private sealed class PlannedStatement
        {
            public AxDbSqlRequest Request { get; set; } = null!;
            public IReadOnlyList<AxDbTableReference> Tables { get; set; } = null!;
            public SqlParameter[] Parameters { get; set; } = null!;
        }
        private sealed class AxDbFailure : Exception
        {
            public string Code { get; }
            public AxDbFailure(string code, string message) : base(message) { Code = code; }
        }
    }
}
