export const axdbSqlTool = {
  name: 'axdb_sql',
  description: 'Live AxDB SQL; may write. Fetch contract. Preserve UI flows under test.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'status', 'schema', 'query', 'execute'] },
    },
    required: ['action'], // additional properties allowed; strict parameters come from contract
  },
};
