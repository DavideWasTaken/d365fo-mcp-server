export const verifyUiCustomizationTool = {
  name: 'verify_ui_customization',
  description:
    'Two UI cases post-deploy. Fetch contract; ask on requiresUserInput. May write.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'run'] },
      profilePath: { type: 'string' },
      environmentUrl: { type: 'string' },
      plan: {
        type: 'object',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
