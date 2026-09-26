import { summarizeReport } from './uiVerification/report.js';
import { InputSchema, getContract } from './uiVerification/contract.js';
import { runVerification, type RunOptions } from './uiVerification/runner.js';
import { MissingUiEnvironmentUrl } from './uiVerification/profile.js';
import { readPlan } from './uiVerification/plans.js';
export async function verifyUiCustomizationTool(args: unknown, options: RunOptions = {}) {
  try {
    const input = InputSchema.parse(args);
    if (input.action === 'contract')
      return { content: [{ type: 'text' as const, text: JSON.stringify(getContract()) }] };
    if (input.action === 'authenticate') {
      const { authenticateUi } = await import('./uiVerification/authenticate.js');
      const result = await authenticateUi(input.profilePath, input, { signal: options.signal });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
    const plan = input.plan ?? (await readPlan(input.planPath!));
    const result = await runVerification(input.profilePath, plan, {
      ...options,
      environmentUrl: input.environmentUrl,
      timeouts: input.timeouts,
    });
    const text = summarizeReport(result);
    return { content: [{ type: 'text' as const, text }] };
  } catch (e) {
    if (e instanceof MissingUiEnvironmentUrl) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'NOT_VERIFIED',
              requiresUserInput: true,
              missingField: 'environmentUrl',
              question: 'What is the D365FO environment URL for this UI test? You can also skip testing.',
              nextAction:
                'Ask the user this question in their language and wait. If they provide a URL, repeat the requested action with environmentUrl and its original arguments. If they decline, skip it. Do not guess the URL or rerun setup. The answer applies only to this call; verification still requires saved browser login.',
            }),
          },
        ],
      };
    }
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `NOT_VERIFIED: ${String(e instanceof Error ? e.message : e).slice(0, 1500)}. Use action="contract" for the strict plan and profile schemas.`,
        },
      ],
    };
  }
}
