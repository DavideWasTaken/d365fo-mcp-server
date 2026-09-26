export const verifyUiCustomizationTool = {
  name: 'verify_ui_customization',
  description: 'UI tests or saved login. Fetch contract (topic guided for AI browser sessions); ask on requiresUserInput. May write.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'run', 'authenticate', 'start', 'observe', 'case', 'act', 'check', 'finish'] },
    },
    required: ['action'],
  },
};
