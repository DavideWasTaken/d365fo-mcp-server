export const verifyUiCustomizationTool = {
  name: 'verify_ui_customization',
  description:
    'Run two requirement-based UI cases after build/deploy. Call action="contract" once for strict plan/profile schemas and example. Uses local saved browser auth; may modify test data. No LLM judge or retries.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'run'] },
      profilePath: { type: 'string', description: 'Optional JSON profile; defaults to MCP setup.' },
      plan: {
        type: 'object',
        additionalProperties: true,
        description: 'Strict executable plan returned by action="contract"; required for run.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
