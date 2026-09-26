import { resolveAxDbConfig } from '../../config/axdbSql.js';
import type { AxDbMethod } from '../../bridge/bridgeTypes.js';
import { SqlInputSchema, sqlContract } from './axdbSql/contract.js';
import { boundedSqlResult } from './axdbSql/output.js';

export interface AxDbContext {
  bridge?: { isReady?: boolean; axdbSqlAvailable?: boolean; callAxDb: (method: AxDbMethod, args: Record<string, unknown>) => Promise<unknown> };
}
const reply = (data: unknown, isError = false) => ({
  ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

export async function axdbSqlTool(args: unknown, context: AxDbContext) {
  let dispatchedWrite = false;
  try {
    const input = SqlInputSchema.parse(args);
    if (input.action === 'contract') return reply(sqlContract());
    const config = resolveAxDbConfig();
    if (!config) return reply({ code: 'SQL_DISABLED', message: 'SQL was not configured or was disabled. Do not use SQL. Run d365fo-mcp config sql to configure it, then restart MCP.' }, true);
    if (!context.bridge?.isReady || !context.bridge.axdbSqlAvailable)
      return reply({ code: 'SQL_BRIDGE_UNAVAILABLE', message: 'An updated Windows bridge with AxDB SQL enabled is required. On the D365FO developer VM run npm run bridge:build to verify, then stop MCP and run dotnet build bridge/D365MetadataBridge -c Release to update the deployed binary. Restart MCP.' }, true);
    if (input.action === 'execute' && !config.allowWrites)
      return reply({ code: 'SQL_WRITES_DISABLED', message: 'This SQL installation is configured for reads only. Change sql.allowWrites through d365fo-mcp config sql to enable writes.' }, true);
    const methods = { status: 'axdbStatus', schema: 'axdbSchema', query: 'axdbQuery', execute: 'axdbExecute' } as const;
    const { action, ...parameters } = input;
    dispatchedWrite = action === 'execute';
    const result = await context.bridge.callAxDb(methods[action], parameters);
    if (!result || typeof result !== 'object' || !('success' in result) || typeof result.success !== 'boolean')
      throw new Error('Invalid SQL bridge response; operation outcome cannot be established.');
    return reply(boundedSqlResult(result as Record<string, unknown>), !result.success);
  } catch (error) {
    return reply({ code: 'SQL_ERROR', ...(dispatchedWrite ? { transactionState: 'UNKNOWN', nextAction: 'Inspect the affected records before another write. Do not retry automatically.' } : {}),
      message: String(error instanceof Error ? error.message : error).slice(0, 1500) }, true);
  }
}
