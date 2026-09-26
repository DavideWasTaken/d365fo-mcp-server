export const verifyUiCustomizationTool = {
  name: 'verify_ui_customization',
  description:
    'Run two UI cases after build/deploy. Call action="contract" for schemas. Ask user when requiresUserInput is returned. Uses saved auth; may modify test data.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'run'] },
      profilePath: { type: 'string', description: 'Optional JSON profile override.' },
      environmentUrl: { type: 'string', description: 'URL if setup left empty.' },
      plan: {
        type: 'object',
        additionalProperties: true,
        description: 'Plan from action="contract"; required for run.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
