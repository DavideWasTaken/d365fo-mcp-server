using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace D365MetadataBridge.Services
{
    public sealed class AxDbTableReference
    {
        public string Schema { get; set; } = "dbo";
        public string Table { get; set; } = "";
    }

    /// <summary>Conservative AST validation. SQL permissions remain the security boundary.</summary>
    public static class AxDbSqlPolicy
    {
        private static readonly HashSet<string> Functions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "COUNT", "COUNT_BIG", "SUM", "AVG", "MIN", "MAX", "ABS", "ROUND", "CEILING", "FLOOR",
            "LEN", "DATALENGTH", "LOWER", "UPPER", "LTRIM", "RTRIM", "TRIM", "LEFT", "RIGHT", "SUBSTRING",
            "REPLACE", "CONCAT", "CONCAT_WS", "CHARINDEX", "PATINDEX", "ISNULL", "NULLIF", "COALESCE",
            "GETDATE", "GETUTCDATE", "SYSDATETIME", "SYSUTCDATETIME", "DATEADD", "DATEDIFF", "DATEDIFF_BIG",
            "DATEPART", "DATENAME", "YEAR", "MONTH", "DAY", "EOMONTH", "ROW_NUMBER", "RANK", "DENSE_RANK",
            "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "STRING_AGG", "STDEV", "STDEVP", "VAR", "VARP"
        };

        public static IReadOnlyList<AxDbTableReference> Validate(string sql, bool write)
        {
            if (string.IsNullOrWhiteSpace(sql) || sql.Length > 65536)
                throw new ArgumentException("SQL must contain 1..65536 characters.");
            var parser = new TSql160Parser(true);
            var script = (TSqlScript)parser.Parse(new StringReader(sql), out var errors);
            if (errors.Count != 0) throw new ArgumentException("Invalid SQL: " + errors[0].Message);
            if (script.Batches.Count != 1 || script.Batches[0].Statements.Count != 1)
                throw new ArgumentException("Exactly one SQL statement is required per item; batches are not allowed.");
            var statement = script.Batches[0].Statements[0];
            if (write ? !(statement is InsertStatement || statement is UpdateStatement || statement is DeleteStatement) : !(statement is SelectStatement))
                throw new ArgumentException(write ? "Only INSERT, UPDATE and DELETE are allowed." : "Only SELECT is allowed.");

            var nodes = Walk(statement).ToList();
            // Exact spelling is conservative across both case-sensitive and case-insensitive database collations.
            // A case-folded match could hide a distinct physical table on a case-sensitive database.
            var ctes = new HashSet<string>(nodes.OfType<CommonTableExpression>().Select(c => c.ExpressionName.Value), StringComparer.Ordinal);
            // An UPDATE/DELETE target may bind to an alias in its own FROM clause only.
            // Aliases inside EXISTS, scalar subqueries or derived-table bodies cannot hide a real target.
            var from = (statement as UpdateStatement)?.UpdateSpecification.FromClause ??
                (statement as DeleteStatement)?.DeleteSpecification.FromClause;
            var aliases = new HashSet<string>(StringComparer.Ordinal);
            if (from != null)
                foreach (var source in from.TableReferences)
                    foreach (var alias in OuterAliases(source)) aliases.Add(alias);
            var targets = new HashSet<TSqlFragment>(nodes.OfType<DataModificationSpecification>().Select(d => (TSqlFragment)d.Target));
            var tables = new List<AxDbTableReference>();
            foreach (var node in nodes)
            {
                var kind = node.GetType().Name;
                if (node is TSqlStatement nested && nested != statement)
                    throw new ArgumentException("Nested SQL statements are not supported.");
                if (node is SelectStatement select && select.Into != null)
                    throw new ArgumentException("SELECT INTO is not allowed.");
                if (kind == "OutputClause" || kind == "OutputIntoClause" || kind == "ExecuteInsertSource" ||
                    kind == "NextValueForExpression" || kind == "SelectSetVariable" || kind.EndsWith("ForClause", StringComparison.Ordinal) ||
                    node is TableHint || node is OptimizerHint || node is UserDataTypeReference)
                    throw new ArgumentException("Unsupported SQL construct: " + kind + ".");
                if (node is FunctionCall function && (function.CallTarget != null || !Functions.Contains(function.FunctionName.Value)))
                    throw new ArgumentException("Only supported built-in SQL functions are allowed.");
                if (kind == "UserDefinedTypeCallTarget" || kind == "MultiPartIdentifierCallTarget")
                    throw new ArgumentException("User-defined methods are not allowed.");
                if (node is TableReference && !(node is NamedTableReference || node is QueryDerivedTable ||
                    node is QualifiedJoin || node is UnqualifiedJoin || node is JoinParenthesisTableReference || node is InlineDerivedTable))
                    throw new ArgumentException("Unsupported table source: " + kind + ".");
                if (node is NamedTableReference table)
                {
                    var name = table.SchemaObject;
                    if (name.Identifiers.Count > 2 || name.Identifiers.Count == 0 || name.BaseIdentifier.Value.StartsWith("#", StringComparison.Ordinal))
                        throw new ArgumentException("Only local database tables and CTEs are allowed.");
                    if (name.Identifiers.Count == 1 && (ctes.Contains(name.BaseIdentifier.Value) || (targets.Contains(table) && aliases.Contains(name.BaseIdentifier.Value)))) continue;
                    // Empty schema means SQL's normal default-schema resolution, not an assumed dbo object.
                    tables.Add(new AxDbTableReference { Schema = name.SchemaIdentifier?.Value ?? "", Table = name.BaseIdentifier.Value });
                }
            }
            return tables;
        }

        private static IEnumerable<string> OuterAliases(TableReference source)
        {
            if (source is TableReferenceWithAlias named && named.Alias != null) yield return named.Alias.Value;
            if (source is JoinTableReference join)
            {
                foreach (var alias in OuterAliases(join.FirstTableReference)) yield return alias;
                foreach (var alias in OuterAliases(join.SecondTableReference)) yield return alias;
            }
            if (source is JoinParenthesisTableReference parenthesis)
                foreach (var alias in OuterAliases(parenthesis.Join)) yield return alias;
        }

        // Reflection walks only AST children, not tokens/parents. This also sees constructs nested in expressions/CTEs.
        private static IEnumerable<TSqlFragment> Walk(TSqlFragment root)
        {
            yield return root;
            foreach (var property in root.GetType().GetProperties())
            {
                if (property.GetIndexParameters().Length != 0 || property.Name == "ScriptTokenStream") continue;
                if (typeof(TSqlFragment).IsAssignableFrom(property.PropertyType))
                {
                    if (property.GetValue(root) is TSqlFragment child)
                        foreach (var node in Walk(child)) yield return node;
                }
                else if (property.PropertyType.IsGenericType && typeof(IEnumerable).IsAssignableFrom(property.PropertyType) &&
                    typeof(TSqlFragment).IsAssignableFrom(property.PropertyType.GetGenericArguments()[0]))
                {
                    if (property.GetValue(root) is IEnumerable children)
                        foreach (TSqlFragment child in children)
                            foreach (var node in Walk(child)) yield return node;
                }
            }
        }
    }
}
