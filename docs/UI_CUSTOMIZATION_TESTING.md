# Browser verification of D365FO customizations

This fork adds **`verify_ui_customization`**, a local MCP tool for two requirement-based UI cases. The agent develops the customization with the existing tools, builds/syncs/deploys it, then explicitly calls this tool. Browser execution and Markdown reporting contain no model calls. The agent prepares the cases once; exploring the actual UI to identify selectors may still consume tokens.

The first version supports bounded, pre-planned browser actions. It does not interpret arbitrary requirements, judge screenshots with AI, repair selectors or trigger automatically after every build. Passing two cases is evidence for those cases, not complete regression coverage.

## Install this fork

Use Node.js 24 or later. The upstream npm package and hosted server do not include this tool.

```powershell
git clone https://github.com/DavideWasTaken/d365fo-mcp-server.git
cd d365fo-mcp-server
npm ci
npx playwright install chromium
npm run build
```

Point the local MCP configuration at this checkout's `dist/index.js`, following [local setup](SETUP.md). The tool is included in the `full` and `core` tool profiles, in `full` or `write-only` server mode; it is excluded from `read-only` mode. It does not need the symbol database to execute.

## Configure the environment once

Run `npm run setup` in this fork and fill in **Environment URL for UI tests**. The optional answer is saved as `environment.uiTestUrl` in the existing `config/d365fo-mcp.json`. Per-instance setup stores its own URL. Existing installations can instead run `npx tsx src/cli/index.ts config environment` (add `--instance NAME` for an instance). Restart the MCP after changing configuration.

The tool reuses this URL whenever `profilePath` is omitted. No separate profile file is required. The advanced environment settings `uiStorageState` and `uiOutputDir` default to `.d365fo-ui/auth.json` and `.d365fo-ui/reports`, relative to the installation or instance directory, independent of the MCP process working directory. Environment-variable overrides are `D365FO_UI_TEST_URL`, `D365FO_UI_STORAGE_STATE` and `D365FO_UI_OUTPUT_DIR`.

When a separate instance configuration is selected, UI settings from another installation's ambient `.env` are ignored. Deliberate shell overrides and an explicitly selected `ENV_FILE` still apply.

You can leave the URL empty during setup. If you later request a UI test, the tool returns `requiresUserInput: true` with a question for the calling agent to ask in your language. Provide the URL or choose to skip testing. The agent resumes with the same plan plus `environmentUrl`, without restarting the MCP or rerunning setup. That answer fills only an empty configured URL, applies to that run and is not saved. Existing configuration or an explicit profile takes precedence. The tool never guesses an environment URL. If you never request UI testing, no URL or browser login is needed.

## Save a local browser login

Use a test environment and dedicated test records. The runner performs real UI actions, including saving records when instructed. Each case gets its own browser context, but both still operate on the same server-side environment: choose independent data.

From the installation directory (or instance directory), create a local, ignored directory and sign in once using Playwright's browser, using the same URL entered in setup. If you customized `uiStorageState`, save to that path instead:

```powershell
New-Item -ItemType Directory -Force .d365fo-ui
npx playwright codegen --save-storage=.d365fo-ui/auth.json https://YOUR-TEST-ENVIRONMENT.operations.dynamics.com
```

Complete the normal login/MFA yourself, wait for the D365FO application, then close the browser to save state. This does not read your personal Chrome profile. Expired sessions require repeating this step. Some authentication policies require additional setup; the tool reports a block if the saved state cannot reach the application. See [Playwright authentication](https://playwright.dev/docs/auth).

### Optional profile override

For a one-off environment or visible browser, you can still save `.d365fo-ui/profile.json` and pass its absolute path as `profilePath`. It completely replaces the configured URL and paths for that run:

```json
{
  "baseUrl": "https://YOUR-TEST-ENVIRONMENT.operations.dynamics.com",
  "storageState": "auth.json",
  "outputDir": "reports",
  "headless": true
}
```

Paths inside the profile resolve relative to the profile file. `headless:false` shows the dedicated test browser. The optional browser `channel` can select an installed supported browser; omit it to use Playwright Chromium. Keep profile, auth state, plans with real data, screenshots and reports local. `.d365fo-ui/` and `playwright/.auth/` are ignored by Git.

## Invoke from the agent

1. Finish generation, build, required DB synchronization and deployment. Identify the build/revision actually available in the test environment.
2. Fetch `verify_ui_customization` with `{"action":"contract"}` once. This returns the complete validated contract and example, keeping the ordinary MCP tool catalogue small.
3. Derive two cases from the **original requirement**, not from the generated implementation: one happy path and the most important negative/boundary case. Each case needs executable preconditions and at least one functional assertion.
4. Observe the actual DOM to identify unambiguous selectors, including the active company indicator. Do not infer working browser selectors from X++ control names alone.
5. Call `action="run"` with the plan; the tool uses the environment saved in setup. If `requiresUserInput` is returned, ask the user the provided question and wait; resume with their `environmentUrl`, or stop if they skip testing. Supply `profilePath` only for an explicit override. Read the compact response and local report. Investigate a failure before choosing to rerun; the tool does not automatically repeat writes.

Example agent instruction:

> After this customization is built, synchronized and deployed to my test environment, verify the original requirement using the environment configured in setup and the saved browser login. Run exactly two independent cases: valid input and the most important invalid input. Reopen any saved record when persistence is part of the requirement. Return only the journey, expected/observed result and outcome for each case.

## Two-case example

The following **illustrative** plan tests a fictional form requiring a positive quantity. The URL, selectors and messages are examples; replace them with observed values from the actual customized form. They are not universal D365FO selectors.

```json
{
  "action": "run",
  "plan": {
    "requirement": "REQ-42: quantities greater than zero are accepted; zero is rejected with a validation message.",
    "buildReference": { "reference": "my-customization-build-42", "ready": true },
    "company": "USMF",
    "startUrl": "/?cmp=USMF&mi=MyQuantityForm",
    "companySelector": "[data-testid='active-company']",
    "cases": [
      {
        "name": "Accept a positive quantity",
        "preconditions": [
          { "selector": "[data-testid='quantity']", "check": "visible", "expected": true },
          { "selector": "[data-testid='validate']", "check": "enabled", "expected": true }
        ],
        "steps": [
          { "action": "fill", "selector": "[data-testid='quantity']", "value": "5" },
          { "action": "click", "selector": "[data-testid='validate']" },
          { "action": "assert", "selector": "[data-testid='result']", "check": "text", "expected": "Quantity accepted" }
        ]
      },
      {
        "name": "Reject zero quantity",
        "preconditions": [
          { "selector": "[data-testid='quantity']", "check": "visible", "expected": true },
          { "selector": "[data-testid='validate']", "check": "enabled", "expected": true }
        ],
        "steps": [
          { "action": "fill", "selector": "[data-testid='quantity']", "value": "0" },
          { "action": "click", "selector": "[data-testid='validate']" },
          { "action": "assert", "selector": "[data-testid='result']", "check": "text", "expected": "Quantity must be greater than zero" }
        ]
      }
    ]
  }
}
```

`buildReference.ready` is a prerequisite declared by the caller. The browser does not attest which assembly was deployed; the report labels this reference as declared. `ready:false` produces NOT_VERIFIED without running the cases.

Supported steps: `navigate`, `click`, `fill`, `select`, `press`, `wait`, `assert`. Assertions observe `visible`, `text`, `value` or `enabled`; boolean checks take booleans, text/value checks take strings. Assertions may appear between actions, so saving, reopening and checking a record can be expressed in one case. `select` addresses native select elements; D365FO lookups and virtualized grids may need explicit click/fill/press sequences. This version provides no universal adapter for complex controls or frames.

Limits: exactly two cases, at most 20 steps each, at most 15 seconds per wait and 120 seconds per case. Cases stop at their first error and are not retried. The second runs independently when its own preconditions can be satisfied. Navigation must stay on the configured environment origin. This first version rejects every HTTP navigation redirect, including redirects within the same origin, as NOT_VERIFIED before following it. Use the final application URL and refresh the saved login state when needed. Normal SPA navigation without an HTTP redirect is supported; subresources such as CDN scripts are not subject to this navigation restriction.

## Read the report

The response gives the overall result, the two case outcomes, a bounded journey with expected/observed evidence, and the report path. The Markdown report records the requirement, declared build, environment/company, duration, actual steps completed, expected and observed values, and the stopping point. An error screenshot is local and optional; it is not sent to a model.

| Outcome | Meaning |
|---|---|
| PASS | All assertions in this case matched their expected results. |
| FAIL | With required state reached, an observed functional result contradicted the requirement-based expectation. |
| NOT_VERIFIED | Missing session/build readiness, unmet precondition, ambiguous selector, navigation/action error or another technical block prevented a verdict. |

Overall FAIL takes precedence over NOT_VERIFIED, and NOT_VERIFIED over PASS. Always inspect the two individual outcomes. An expected business rejection is a **passing negative case** if the expected rejection actually appears.

## Validation scope

Run the browser fixture checks with `npm run test:ui` after installing Chromium. Run the input/report tests with `npm run test:run -- tests/tools/verify-ui-customization.test.ts`.

Automated fixture tests exercise actual Chromium interaction and the result/report logic. They do not prove compatibility with a live D365FO form. Before relying on this fork for a real customization, run its two cases against the deployed D365FO environment and inspect the evidence. Uncovered requirement criteria remain outside the verdict.
