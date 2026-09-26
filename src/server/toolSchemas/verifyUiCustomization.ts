export const verifyUiCustomizationTool = {
  name: 'verify_ui_customization',
  description: 'UI verification or saved login. Fetch contract; ask on requiresUserInput. May write.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'run', 'authenticate'] },
    },
    required: ['action'],
  },
};
