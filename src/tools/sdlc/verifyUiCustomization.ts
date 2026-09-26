import { summarizeReport } from './uiVerification/report.js';
import { InputSchema, getContract } from './uiVerification/contract.js';
import { runVerification, type RunOptions } from './uiVerification/runner.js';
export async function verifyUiCustomizationTool(args: unknown, options: RunOptions = {}) {
  try {
    const input = InputSchema.parse(args);
    if (input.action === 'contract')
      return { content: [{ type: 'text' as const, text: JSON.stringify(getContract()) }] };
    const result = await runVerification(input.profilePath, input.plan, options);
    const text = summarizeReport(result);
    return { content: [{ type: 'text' as const, text }] };
  } catch (e) {
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
