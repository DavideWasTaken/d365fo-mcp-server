import { z } from 'zod';

const short = z.string().trim().min(1).max(1000);
const selector = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^(?![\s\S]*>>)[\s\S]*$/, 'CSS selector chaining is not allowed')
  .describe('Unique CSS selector observed on the real DOM; never inferred from X++ metadata.');
const url = z.string().min(1).max(2000);
const booleanAssertion = { selector, check: z.enum(['visible', 'enabled']), expected: z.boolean() };
const textAssertion = {
  selector,
  check: z.literal('text'),
  expected: z.string().max(2000),
  match: z.enum(['exact', 'contains']).optional(),
};
const valueAssertion = { selector, check: z.literal('value'), expected: z.string().max(2000) };
const meaningfulContains = (a: { expected: string; match?: string }) =>
  a.match !== 'contains' || a.expected.trim().length > 0;
export const AssertionSchema = z.union([
  z.object(booleanAssertion).strict(),
  z.object(textAssertion).strict().refine(meaningfulContains, 'contains requires non-empty expected text'),
  z.object(valueAssertion).strict(),
]);
export const TimeoutsSchema = z
  .object({
    stepTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    navigationTimeoutMs: z.number().int().min(1000).max(180000).optional(),
    caseTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  })
  .strict();
export const StepSchema = z.union([
  z.object({ action: z.literal('navigate'), url }).strict(),
  z.object({ action: z.literal('click'), selector }).strict(),
  z.object({ action: z.literal('fill'), selector, value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('select'), selector, value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('press'), selector, key: short }).strict(),
  z.object({ action: z.literal('wait'), selector }).strict(),
  z.object({ action: z.literal('assert'), ...booleanAssertion }).strict(),
  z
    .object({ action: z.literal('assert'), ...textAssertion })
    .strict()
    .refine(meaningfulContains, 'contains requires non-empty expected text'),
  z.object({ action: z.literal('assert'), ...valueAssertion }).strict(),
]);
export const PlanSchema = z
  .object({
    requirement: short,
    buildReference: z
      .object({
        reference: short,
        ready: z.boolean().describe('Caller declares build, deployment and any required sync are ready.'),
      })
      .strict(),
    company: z.string().trim().min(1).max(100),
    startUrl: url,
    companySelector: selector,
    cases: z
      .array(
        z
          .object({
            name: short,
            scope: selector.optional(),
            preconditions: z.array(AssertionSchema).min(1).max(10),
            steps: z
              .array(StepSchema)
              .min(1)
              .max(20)
              .refine(s => s.some(v => v.action === 'assert'), 'At least one functional assertion is required'),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
export const ProfileSchema = z
  .object({
    baseUrl: z
      .url()
      .regex(/^[hH][tT][tT][pP][sS]?:\/\//, 'HTTP(S) URL required')
      .refine(value => {
        try {
          const parsed = new URL(value);
          return !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      }, 'Embedded credentials are not allowed'),
    storageState: short,
    outputDir: short,
    headless: z.boolean().optional(),
    channel: short.optional(),
    timeouts: TimeoutsSchema.optional(),
    authenticationOrigins: z
      .array(
        z.url().refine(value => {
          try {
            const u = new URL(value);
            const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
            return (
              !u.username &&
              !u.password &&
              !u.hostname.includes('*') &&
              !u.search &&
              !u.hash &&
              u.pathname === '/' &&
              (u.protocol === 'https:' || (loopback && u.protocol === 'http:'))
            );
          } catch {
            return false;
          }
        }, 'Use an exact HTTPS origin (HTTP allowed only for loopback fixtures)'),
      )
      .max(10)
      .optional(),
  })
  .strict();
export const InputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('contract'), topic: z.enum(['deterministic', 'guided', 'profile']).optional() }).strict(),
  z
    .object({
      action: z.literal('run'),
      profilePath: short.optional(),
      environmentUrl: ProfileSchema.shape.baseUrl.optional(),
      plan: PlanSchema.optional(),
      planPath: short.optional(),
      timeouts: TimeoutsSchema.optional(),
    })
    .strict()
    .refine(v => !!v.plan !== !!v.planPath, 'Supply exactly one of plan or planPath'),
  z
    .object({
      action: z.literal('authenticate'),
      profilePath: short.optional(),
      environmentUrl: ProfileSchema.shape.baseUrl.optional(),
      company: z.string().trim().min(1).max(100),
      companySelector: selector,
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    })
    .strict(),
]);
export type Plan = z.infer<typeof PlanSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type Step = z.infer<typeof StepSchema>;
export const examplePlan: Plan = {
  requirement: 'The dedicated order quantity must be positive before saving.',
  buildReference: { reference: 'deployed build 2026.09.26.1', ready: true },
  company: 'USMF',
  startUrl: '/?cmp=USMF',
  companySelector: '#company',
  cases: [
    {
      name: 'Positive quantity',
      preconditions: [{ selector: '#record', check: 'text', expected: 'UI-TEST-001' }],
      steps: [
        { action: 'fill', selector: '#quantity', value: '2' },
        { action: 'click', selector: '#save' },
        { action: 'assert', selector: '#result', check: 'text', expected: 'Saved' },
      ],
    },
    {
      name: 'Zero quantity rejected',
      preconditions: [{ selector: '#record', check: 'text', expected: 'UI-TEST-001' }],
      steps: [
        { action: 'fill', selector: '#quantity', value: '0' },
        { action: 'click', selector: '#save' },
        { action: 'assert', selector: '#result', check: 'text', expected: 'Quantity must be positive' },
      ],
    },
  ],
};
export function getContract() {
  const planSchema = z.toJSONSchema(PlanSchema);
  // Zod custom refinements are not expressible automatically in JSON Schema.
  const steps = (planSchema as any).properties.cases.items.properties.steps;
  steps.contains = { type: 'object', properties: { action: { const: 'assert' } }, required: ['action'] };
  steps.minContains = 1;
  return {
    inputSchema: z.toJSONSchema(InputSchema),
    planSchema,
    profileSchema: z.toJSONSchema(ProfileSchema),
    rules: [
      'Use two independent cases by default (happy path plus negative/boundary), with 1..5 explicitly planned cases allowed. At most 20 steps each; create records through UI when creation is under test.',
      'Choose setup from the requirement: if creation/defaulting/validation/CoC is under test, create and act through UI or X++; do not pre-insert the expected state with SQL. Optional axdb_sql is for debug, extra DB checks or unrelated prerequisites, not automatic setup. SQL disabled does not block UI tests.',
      'Observe CSS selectors on the real DOM. Each case may supply scope for the active visible form or row. Actions require one visible match within scope; never pick the first ambiguous row. No raw code or eval.',
      'Preconditions establish authentication, data and readiness. Company text is checked exactly before every step.',
      'Build readiness is caller-declared, not browser-attested. Reopen saved records when persistence is the requirement.',
      'visible/enabled expected must be boolean; value remains exact. text optionally uses match=contains with non-empty expected text; default exact. Company always compares exactly.',
      'Timeouts in profile or run: defaults step30s/navigation60s/case180s; caps120s/180s/600s. No action or whole-case retry. Only declared scenarios are covered.',
      'Verification permits same-origin navigation redirects, validating each hop. External authentication redirects stop verification; never resume/replay a possibly written case automatically.',
      'Use action=authenticate separately for human login/MFA in an owned visible browser; supply company/companySelector. Only environment plus profile.authenticationOrigins (default https://login.microsoftonline.com and https://login.windows.net) are allowed. Save state only after return to the environment and exact company check. No credentials in tool input.',
      'Use value assertions for native input/textarea/select; text reads actual element text. An incompatible text/value binding is NOT_VERIFIED, never a functional FAIL. Normal setup environment.uiBrowserChannel selects auto/chromium/msedge; auto falls back to Edge only on Chromium launch failure and reports its choice.',
      'run accepts exactly one of plan or planPath. Every run saves validated plan.json next to its report. Review build readiness and data preconditions before reusing it; plans and auth files stay local.',
      'Profile paths resolve relative to the profile file. Auth state is loaded into separate sequential browser contexts; never a personal browser.',
      'Omit profilePath to use environment.uiTestUrl and the saved login/report paths from normal MCP setup. An explicit profile replaces these settings entirely.',
      'If requiresUserInput is returned, ask its question and wait. Repeat the requested action with the user-provided environmentUrl or skip if declined. This URL only fills an empty setup URL and is not saved. Never guess an environment.',
    ],
    example: { action: 'run', plan: examplePlan },
    profileExample: {
      baseUrl: 'https://your-test-env.operations.dynamics.com',
      storageState: 'auth.json',
      outputDir: 'reports',
      headless: true,
    },
  };
}
