export const axdbSqlTool = {
  name: 'axdb_sql',
  description: 'Live AxDB SQL on the dev VM; writes only if enabled. Fetch contract first.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'status', 'schema', 'query', 'execute'] },
    },
    required: ['action'], // additional properties allowed; strict parameters come from contract
  },
};
