import { summarizeReport } from './uiVerification/report.js';
import { InputSchema, getContract } from './uiVerification/contract.js';
import { runVerification, type RunOptions } from './uiVerification/runner.js';
import { MissingUiEnvironmentUrl } from './uiVerification/profile.js';
import { readPlan } from './uiVerification/plans.js';
import { guidedContract, GUIDED_ACTIONS } from './uiVerification/guided/contract.js';
import type { GuidedSessionManager } from './uiVerification/guided/sessionManager.js';
import { currentUiRequest } from '../../server/uiRequestContext.js';
export async function verifyUiCustomizationTool(
  args: unknown,
  options: RunOptions & { guidedManager?: GuidedSessionManager; transport?: 'http' | 'stdio' } = {},
) {
  try {
    if (args && typeof args === 'object' && GUIDED_ACTIONS.has((args as { action: string }).action)) {
      const request = currentUiRequest();
      if (options.transport !== 'stdio' && (options.transport !== 'http' || !request?.local))
        throw new Error('Guided UI requires stdio or a trusted loopback HTTP request');
      if (!options.guidedManager) throw new Error('Guided UI sessions are unavailable on this server');
      const signals = [options.signal, request?.signal].filter((value): value is AbortSignal => !!value);
      const result = await options.guidedManager.call(args, signals.length ? AbortSignal.any(signals) : undefined);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result.payload) },
          ...(result.image ? [{ type: 'image' as const, ...result.image }] : []),
        ],
      };
    }
    const input = InputSchema.parse(args);
    if (input.action === 'contract')
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              input.topic === 'guided'
                ? guidedContract()
                : input.topic === 'profile'
                  ? { profileSchema: getContract().profileSchema, example: getContract().profileExample }
                  : getContract(),
            ),
          },
        ],
      };
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
    if (args && typeof args === 'object' && GUIDED_ACTIONS.has((args as { action: string }).action)) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'NOT_VERIFIED',
              code: 'INVALID_REQUEST',
              message: String(e instanceof Error ? e.message : e).slice(0, 1500),
              nextAction: 'Fetch contract with topic="guided"; do not replay uncertain interactions.',
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
