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
const textAssertion = { selector, check: z.enum(['text', 'value']), expected: z.string().max(2000) };
export const AssertionSchema = z.union([z.object(booleanAssertion).strict(), z.object(textAssertion).strict()]);
export const StepSchema = z.union([
  z.object({ action: z.literal('navigate'), url }).strict(),
  z.object({ action: z.literal('click'), selector }).strict(),
  z.object({ action: z.literal('fill'), selector, value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('select'), selector, value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('press'), selector, key: short }).strict(),
  z.object({ action: z.literal('wait'), selector }).strict(),
  z.object({ action: z.literal('assert'), ...booleanAssertion }).strict(),
  z.object({ action: z.literal('assert'), ...textAssertion }).strict(),
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
            preconditions: z.array(AssertionSchema).min(1).max(10),
            steps: z
              .array(StepSchema)
              .min(1)
              .max(20)
              .refine(s => s.some(v => v.action === 'assert'), 'At least one functional assertion is required'),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();
export const ProfileSchema = z
  .object({
    baseUrl: z.url().regex(/^[hH][tT][tT][pP][sS]?:\/\//, 'HTTP(S) URL required'),
    storageState: short,
    outputDir: short,
    headless: z.boolean().optional(),
    channel: short.optional(),
  })
  .strict();
export const InputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('contract') }).strict(),
  z.object({
    action: z.literal('run'),
    profilePath: short.optional(),
    environmentUrl: ProfileSchema.shape.baseUrl.refine(value => {
      try {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password;
      } catch { return false; }
    }, 'Embedded credentials are not allowed').optional(),
    plan: PlanSchema,
  }).strict(),
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
    planSchema,
    profileSchema: z.toJSONSchema(ProfileSchema),
    rules: [
      'Exactly two independent cases using dedicated test data; create records through the UI when creation is under test. At most 20 steps each.',
      'Choose setup from the requirement: if creation/defaulting/validation/CoC is under test, create and act through UI or X++; do not pre-insert the expected state with SQL. Optional axdb_sql is for debug, extra DB checks or unrelated prerequisites, not automatic setup. SQL disabled does not block UI tests.',
      'Observe unique CSS selectors on the real DOM before preparing the plan. No raw code or eval.',
      'Preconditions establish authentication, data and readiness. Company text is checked exactly before every step.',
      'Build readiness is caller-declared, not browser-attested. Reopen saved records when persistence is the requirement.',
      'visible/enabled expected must be boolean; text/value expected must be string (exact match).',
      '15 seconds per step, 120 seconds per case; no whole-case retry. Only the two declared scenarios are covered.',
      'Only navigation to the configured exact HTTP(S) origin is allowed. All HTTP navigation redirects are NOT_VERIFIED; use the final application URL and refresh saved login.',
      'Profile paths resolve relative to the profile file. Auth state is loaded into separate sequential browser contexts; never a personal browser.',
      'Omit profilePath to use environment.uiTestUrl and the saved login/report paths from normal MCP setup. An explicit profile replaces these settings entirely.',
      'If a run returns requiresUserInput, ask its question and wait. Pass the user-provided environmentUrl with the same plan to resume, or skip if they decline. This one-run URL only fills an empty setup URL and is not saved. Never guess an environment.',
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
