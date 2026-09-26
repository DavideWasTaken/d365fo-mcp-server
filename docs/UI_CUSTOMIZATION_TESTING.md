# Browser verification of D365FO customizations

This fork adds **`verify_ui_customization`**, a local MCP tool for requirement-based UI cases. Two cases are recommended; one to five are supported. Build, synchronize and deploy the customization before explicitly requesting verification.

**Experimental AI-guided verification** lets the AI already calling MCP inspect the application, choose observed controls and adapt its journey through short calls. **Deterministic `run`** executes a complete plan with selectors, bounded actions and assertions; existing plans remain supported. Neither workflow embeds a second model, requires another LLM API key or starts automatically after a build. Guided observations and optional screenshots are read by the client AI and consume its normal quota. Passing declared cases is evidence for those cases, not complete regression coverage.

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

**Browser for UI tests** is available in setup and per-instance configuration as `environment.uiBrowserChannel` (`D365FO_UI_BROWSER_CHANNEL`). Choose `msedge` for installed Microsoft Edge, `chromium` for Playwright Chromium only, or `auto` (default). Auto tries Edge only if Chromium fails to launch, within the same deadline. It never switches browsers after a navigation, login or test failure; explicit choices never fall back. Responses and reports identify the actual browser and any fallback. An explicit profile remains authoritative, including its own `channel`; an omitted profile channel uses auto rather than another installation's setting.

When a separate instance configuration is selected, UI settings from another installation's ambient `.env` are ignored. Deliberate shell overrides and an explicitly selected `ENV_FILE` still apply.

You can leave the URL empty during setup. If you later request a UI test, the tool returns `requiresUserInput: true` with a question for the calling agent to ask in your language. Provide the URL or choose to skip testing. The agent resumes with the same plan or guided mission plus `environmentUrl`, without restarting the MCP or rerunning setup. That answer fills only an empty configured URL, applies to that run and is not saved. Existing configuration or an explicit profile takes precedence. The tool never guesses an environment URL. If you never request UI testing, no URL or browser login is needed.

## Save a local browser login

Use a test environment and dedicated test records. The runner performs real UI actions, including saving records when instructed. Each case gets its own browser context, but all still operate on the same server-side environment: choose independent data.

For deterministic `run`, call the separate authentication action before running cases (the selector below is illustrative and must be observed on your actual environment):

```json
{
  "action": "authenticate",
  "company": "USMF",
  "companySelector": "[data-testid='active-company']",
  "timeoutMs": 180000
}
```

This opens an owned visible browser. Complete normal login/MFA yourself and select the requested company. The tool saves cookies, local storage and IndexedDB only after returning to the environment and observing the exact company text; it then closes the browser and returns `AUTHENTICATED`. Failure or cancellation preserves the previous auth file. The deadline defaults to 180 seconds and can be raised to 300 seconds. No passwords are passed through MCP and no personal browser profile is read.

Authentication permits navigation to the environment origin and, by default, `https://login.microsoftonline.com` and `https://login.windows.net`. If your tenant uses a different federated identity provider, explicitly set its exact HTTPS origin in `authenticationOrigins` in a profile (include the Microsoft origins you need too). Explicit lists replace the defaults. Wildcards are rejected. These authentication origins are allowed during human login, not as application destinations after company binding. Popup login is unsupported; the tool stops instead of saving an uncertain session. Browser session storage is not persisted, so sessionStorage-only authentication is unsupported. Tenant policies or complex login flows can still require manual setup. See [Playwright authentication](https://playwright.dev/docs/auth).

If a test later redirects to a login origin, it stops with `NOT_VERIFIED`. Authenticate again separately, inspect any writes already performed and explicitly choose whether to rerun. Authentication never automatically resumes or replays a case.

### Optional profile override

For a one-off environment or visible browser, you can still save `.d365fo-ui/profile.json` and pass its absolute path as `profilePath`. It completely replaces the configured URL and paths for that run:

```json
{
  "baseUrl": "https://YOUR-TEST-ENVIRONMENT.operations.dynamics.com",
  "storageState": "auth.json",
  "outputDir": "reports",
  "headless": true,
  "channel": "msedge",
  "authenticationOrigins": ["https://login.microsoftonline.com"],
  "timeouts": {
    "stepTimeoutMs": 30000,
    "navigationTimeoutMs": 60000,
    "caseTimeoutMs": 180000
  }
}
```

Paths inside the profile resolve relative to the profile file. `headless:false` shows the deterministic test browser; authentication and guided sessions always use a visible owned browser. Set `channel:"msedge"` for installed Microsoft Edge, including authentication, use `channel:"chromium"` for Chromium only, or omit it for auto launch selection. Keep profile, auth state, plans with real data, screenshots and reports local. `.d365fo-ui/` and `playwright/.auth/` are ignored by Git.

An omitted channel now uses auto launch selection (Chromium first, then installed Edge on launch failure); use `channel:"chromium"` to disable fallback.

## AI-guided first verification (experimental)

The existing client AI drives this workflow; no additional Playwright MCP server, embedded model or MCP sampling is needed. Keep your local MCP endpoint, for example **`http://localhost:8080/mcp`**. That address is the MCP server, not the Dynamics environment URL; D365 still comes from setup or the profile. Guided sessions persist across local HTTP requests and also support stdio. Remote/hosted guided access is rejected. Local HTTP retains the existing API-key configuration and verifies the real socket, Host and Origin; proxy headers do not grant local access.

Ask the agent to fetch the guided contract once:

```json
{ "action": "contract", "topic": "guided" }
```

The default `contract` remains deterministic; `topic:"profile"` describes the shared profile. Supply a mission with requirements and expected outcomes, without prewritten clicks or CSS selectors. This example uses fictional records and a fictional form; choose the actual deployed form and dedicated records:

```json
{
  "action": "start",
  "mission": {
    "requirement": "REQ-42: positive quantities are accepted; zero is rejected.",
    "buildReference": {
      "reference": "deployed-customization-build-42",
      "ready": true
    },
    "company": "USMF",
    "startUrl": "/?cmp=USMF&mi=MyQuantityForm",
    "cases": [
      {
        "id": "positive",
        "goal": "Save quantity 5 and reopen the same dedicated record",
        "data": {
          "recordKey": "UI-TEST-001",
          "quantity": "5"
        },
        "preconditions": [
          {
            "id": "ready",
            "targetDescription": "Quantity field on the active form",
            "check": "enabled",
            "expected": true
          }
        ],
        "criteria": [
          {
            "id": "identity",
            "targetDescription": "Reopened record identifier",
            "check": "value",
            "expected": "UI-TEST-001"
          },
          {
            "id": "persisted",
            "targetDescription": "Quantity on the reopened record",
            "check": "value",
            "expected": "5"
          }
        ]
      },
      {
        "id": "negative",
        "goal": "Reject zero quantity on an independent record",
        "data": {
          "recordKey": "UI-TEST-002",
          "quantity": "0"
        },
        "preconditions": [
          {
            "id": "ready",
            "targetDescription": "Quantity field on the active form",
            "check": "enabled",
            "expected": true
          }
        ],
        "criteria": [
          {
            "id": "rejected",
            "targetDescription": "Validation message for the attempted zero quantity",
            "check": "text",
            "match": "contains",
            "expected": "Quantity must be positive"
          }
        ]
      }
    ]
  }
}
```

`start` opens owned visible Chromium, or installed Edge when the profile has `channel:"msedge"`. A saved login is reused when available. On `AUTH_REQUIRED`, complete login/MFA yourself in that browser and ask the agent to observe again. Identity-provider DOM, images and field values are not sent to the AI. Do not pass passwords through MCP. Select the requested company manually when necessary; guided mode discovers the company control after returning to the environment, without asking you to write CSS. Separate `authenticate` remains available for deterministic plans.

The returned `sessionId` is a private capability authorizing access to that browser, not proof of conversation identity. Keep it out of page content, shared reports and messages to other users. A normal HTTP response ending leaves the browser available for the next call. A process supports at most two sessions; competing calls in one session return `BUSY`.

### Follow a guided case

1. Call `case` with `operation:"prepare"` and the case ID. The first case adopts the login context; later cases use separate contexts from saved authentication. Repeating prepare for the current case does not restart it. End one case before preparing another.
2. From that case's observation, choose the company control. Call `case` with `operation:"begin"`, its `snapshotId` and `companyRef`. A unique visible control must exactly match the mission company before authentication is saved. Company is rechecked before interactions.
3. Call `check` with `stage:"precondition"`, a mission `criterionId`, current `snapshotId` and observed `ref`. All initial preconditions must pass before `act`. Preconditions must be observable from the start page; creating a record or opening a lookup under test belongs to the case journey.
4. Call `act` with `sessionId`, `caseId`, `snapshotId`, a new `operationId` and one to three actions on observed controls. Supported actions are `click`, `dblclick`, `fill`, native `select`, `check`, `uncheck`, `press`, `scroll`, `wait` and same-origin `navigate`. Flow-changing actions end the batch and return a fresh observation. Even fill/onChange can write server data.
5. Observe as needed, then `check` each final criterion by ID. The expected value is immutable. A measured check with `final:false` can remain `PENDING` while a result settles. New application actions invalidate earlier measured PASS results, requiring current evidence; confirmed FAIL remains recorded. Reopen saved records when persistence is required.
6. Call `case` with `operation:"end"`, complete the other cases, then `finish` with `sessionId`. Finish closes the browser and returns a local report; incomplete cases remain `NOT_VERIFIED`.

A fill action object is `{"type":"fill","ref":"REF_FROM_CURRENT_OBSERVATION","value":"5"}` inside `act.actions`. Replace placeholders with actual returned identifiers. Never invent references or derive them from X++ control names. The guided contract gives every request schema.

Native input/textarea/select observations carry `value` and a `recommendedCheck` hint, without presenting the value as element `text`. Use `check:"value"` for the exact field value, and `check:"text"` for actual text elements such as alerts or labels. A select's value is its option value, not necessarily its visible option label. `CHECK_NOT_APPLICABLE` returns `NOT_VERIFIED` for incompatible bindings, including value checks on labels/containers and boolean checked checks on mixed or unspecified states. It does not freeze a functional FAIL or rewrite the mission. You may bind the unchanged criterion to a compatible observed element; changing its check type requires a new mission after inspecting any writes already made. An unresolved criterion prevents PASS.

For an empty grid exposing `role="alert"` with “Niente da visualizzare”, declare a measured text criterion for that alert and bind it within the intended active form/grid. No AI screenshot judgement is required. This checks the displayed empty-state message; it is not a total-record count. Counting rendered rows alone cannot prove the total of a paged or virtualized grid.

### Measured grid counts and form titles

Guided missions also accept a numeric criterion bound to an observed grid/table:

```json
{ "id": "rows", "targetDescription": "Filtered orders grid", "check": "rowCount", "basis": "total", "expected": 0 }
```

`basis` is mandatory and frozen with the mission. `total` uses `aria-rowcount` and consistent `aria-rowindex` values, subtracting a fully observed leading section of column-header rows. Observe the top of the grid: if non-empty, the first data row must establish the end of that header section. Unknown totals (`-1`), incomplete header evidence, inconsistent indices, loading (`aria-busy`), external ARIA ownership and unsupported row markup return `CHECK_NOT_APPLICABLE` / `NOT_VERIFIED`. The report identifies the count basis. A total of zero is a measured empty grid; when total metadata is unavailable, measure the explicit empty-result alert instead.

`basis:"rendered"` counts visible DOM data rows in the bound grid, excluding column headers and nested grid rows. It can verify viewport contents, but **zero rendered rows does not prove an empty dataset**, and the count is not a server-side total. Both modes cap DOM inspection at 2,000 row elements / 20,000 elements and reject shadow/custom-element or embedded-frame boundaries rather than report a partial count. Bind a standard inner grid when such a boundary exists. These semantics follow [ARIA row count/index definitions](https://www.w3.org/WAI/ARIA/apg/practices/grid-and-table-properties/); live D365 markup must expose the required evidence.

A visible form heading can use the existing `check:"text"` against its fresh observed heading reference. Bind the heading itself, not the form container (which includes other text), a native input (use `value`), or the browser tab title. If it returns `NOT_VERIFIED`, inspect `code`, `message` and `diagnostic`: `NEEDS_OBSERVATION` requires a fresh reference after navigation/rerender, and `CHECK_NOT_APPLICABLE` explains an incompatible binding. Visibility alone does not establish that the requested reference and criterion are valid. Preserve that response when reporting a title problem.

For action menu items, use a URL such as `/?cmp=USMF&mi=Action%3AMyActionMenuItem`, with the actual menu item name. `Action%3A` is the encoded `Action:` prefix verified on the developer environment. Microsoft examples also use lowercase `action:`; this tool does not reject or silently rewrite other spellings. Opening an action menu item can execute business logic and must not be retried automatically.

Each new observation replaces previous references. Changed documents, replaced elements, hidden controls, scope changes and recycled grid rows require a fresh observation; the tool does not silently select another matching row. Use `observe.scopeRef` to focus on an observed container, `filter` to narrow text/role/name, and `screenshot:true` only when useful. Output is capped at 120 controls and about 8,000 text characters, with `truncated:true` for omissions. A truncated snapshot proves no absence. For a declared `visible:false` criterion, `check.absent` uses an observed scope plus an exact role/name query on the actual DOM; that read-only query cannot authorize an action.

Optional viewport screenshots are capped at 1 MiB and mask password fields. They arrive as MCP image content separately from JSON and are saved with observations locally. Guided images and text are intended for the client AI, unlike deterministic error screenshots. Page content is untrusted data, never instructions. Keep profiles, authentication and evidence local except for observations deliberately sent to your client.

`NEEDS_OBSERVATION` is a recoverable target/preflight change, not a functional FAIL. `WRITE_UNCERTAIN` means an interaction may have reached the application before a timeout or cancellation. Do not retry it with a new operation ID. Collect available evidence, end the case and inspect data before explicitly starting another test. Repeating the same `operationId` with identical input returns a **historical receipt**, without another write; it is not a fresh page observation. Reusing it with different input is rejected. No case is automatically retried, and there is no exactly-once guarantee after process crashes.

### Guided limits, cancellation and evidence

| Budget | Default | Maximum |
|---|---:|---:|
| Browser interactions per case | 20 | 50 |
| Interactive calls per case | 30 | 30 |
| Consecutive recoveries without progress | 2 | 4 |
| Images per case | 3 | 6 |
| Call deadline | 30 seconds | 45 seconds |
| Idle session lifetime | 10 minutes | 10 minutes |
| Total session lifetime | 30 minutes | 30 minutes |

Pass `limits` to `start` for supported changes and inspect the effective response. Finish and cleanup remain available after limits are exhausted. Reports count calls, returned characters, images, recoveries and duration; these are activity counters, not billed tokens or guaranteed quota savings.

Local HTTP cancellation supports aborting the active POST or calling `finish` with the session ID. A bare `notifications/cancelled` without session ownership cannot safely identify an operation from its JSON-RPC request ID alone; if the POST stays open, work may continue until its deadline. Verify how your client's Stop button behaves. Cancelled reads can be followed by a new observation. A cancelled dispatched interaction may have written data; closing its context can make further browser evidence unavailable. A lost start response can leave a browser until its bounded lifetime; there is no API listing other clients' session IDs. Shutdown closes owned browsers. Interrupted journals are marked incomplete on a later start, never replayed.

The local report records the mission, declared build, actual journey, expected/observed outcomes, stopping reasons, counters and evidence identifiers. Measured criteria are labelled `MEASURED`. Criteria declared `kind:"ai_review"` at start can receive client-AI judgement with a reason and captured evidence IDs from the same case, taken after its latest interaction; they are labelled `AI_REVIEWED`. The server checks provenance and freshness, not the semantic correctness of that judgement. Choosing which control represents a requirement is still the calling AI's responsibility. PASS requires every precondition and criterion, with no uncertain writes; confirmed FAIL takes precedence over NOT_VERIFIED and PASS.

This first version supports observed DOM controls, application dialogs and screenshots. Arbitrary coordinate clicks, desktop control, drag-and-drop, canvas-only controls without DOM targets, popup workflows and automatic acceptance of native browser confirmations are unsupported. Lookup/grid behavior must be observed on the actual page. Live D365FO, Edge, Entra/MFA and the chosen MCP client's cancellation behavior still need acceptance testing; local Chromium fixtures do not establish that compatibility. SQL remains optional for debug or unrelated prerequisites, never a substitute for a UI/X++ creation, defaulting or validation path under test.

## Invoke the deterministic runner

SQL is optional and independent. Use `axdb_sql` for debugging or extra persisted-data checks when configured, not as automatic UI test setup. If the requirement covers creating records, defaults, validation or CoC, exercise that path through UI/X++ instead of inserting the finished state with SQL. Only prepare unrelated prerequisites with SQL when it actually helps and explain that choice. See [AxDB SQL](AXDB_SQL.md). A disabled SQL configuration never prevents a UI-only test.

1. Finish generation, build, required DB synchronization and deployment. Identify the build/revision actually available in the test environment.
2. Fetch `verify_ui_customization` with `{"action":"contract"}` once. This returns the complete validated contract and example, keeping the ordinary MCP tool catalogue small.
3. Derive cases from the **original requirement**, not from the generated implementation. Use two by default: one happy path and the most important negative/boundary case. One to five cases are allowed when explicitly planned. Each case needs executable preconditions and at least one functional assertion.
4. Observe the actual DOM to identify unambiguous selectors, including the active company indicator. Use a case `scope` for the active visible form or row when needed. Do not infer working browser selectors from X++ control names alone. If the saved login is missing or expired, use `authenticate` separately.
5. Call `action="run"` with the plan; the tool uses the environment saved in setup. If `requiresUserInput` is returned, ask the user the provided question and wait; resume with their `environmentUrl`, or stop if they skip testing. Supply `profilePath` only for an explicit override. Read the compact response and local report. Investigate a failure before choosing to rerun; the tool does not automatically repeat writes.

Example agent instruction:

> After this customization is built, synchronized and deployed to my test environment, verify the original requirement using the environment configured in setup and the saved browser login. Default to two independent cases: valid input and the most important invalid input. Reopen any saved record when persistence is part of the requirement. Return only the journey, expected/observed result and outcome for each case.

## Two-case deterministic example

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
          { "action": "assert", "selector": "[data-testid='result']", "check": "text", "match": "contains", "expected": "Quantity must be greater than zero" }
        ]
      }
    ]
  }
}
```

`buildReference.ready` is a prerequisite declared by the caller. The browser does not attest which assembly was deployed; the report labels this reference as declared. `ready:false` produces NOT_VERIFIED without running the cases.

After compiling new objects, use `build_d365fo_project` with `restartAos:true` and collect its completed result before declaring the build ready. The runtime helper discovers the local IIS `AOSService` pool or matching IIS Express instance, including `/config:... /apppool:Dynamics365`. Resolve a blocked restart or failed readiness check before starting UI tests. See [build/runtime workflow](BUILD_FEEDBACK.md); a compiled DLL alone does not establish that the running AOS loaded the new objects.

Supported steps: `navigate`, `click`, `fill`, `select`, `press`, `wait`, `assert`. Assertions observe `visible`, `text`, `value` or `enabled`; boolean checks take booleans, text/value checks take strings. Text defaults to an exact trimmed comparison; `match:"contains"` accepts a non-empty substring, useful for message bars with extra text. Value and company comparisons remain exact. Assertions may appear between actions, so saving, reopening and checking a record can be expressed in one case. `select` addresses native select elements; D365FO lookups and virtualized grids may need explicit click/fill/press sequences. This version provides no universal adapter for complex controls or frames.

Optional `scope` on each case limits its preconditions and steps to one visible form/container, for example `"scope":"[data-testid='active-form']"`. The company indicator is always checked at page level. Hidden duplicates are ignored; multiple visible matches still produce `NOT_VERIFIED`, so repeated grid rows need an observed row-specific selector. `visible:false` succeeds when no visible match exists (absent or hidden).

Limits: one to five cases, at most 20 steps each. Default timeouts are 30 seconds per step, 60 seconds per navigation and 180 seconds per case; maximums are 120, 180 and 600 seconds. Set `timeouts` in the profile or on `run` (run overrides profile). The case deadline remains an overall cap. Cases stop at their first error and are not retried. Other cases run independently when their own preconditions can be satisfied.

Verification permits same-origin HTTP redirects, checking each navigation hop before following it, with at most ten redirects in one chain. Off-origin navigation, URLs containing credentials and popup navigation stop the affected case with `NOT_VERIFIED`; other independent cases still check their own preconditions. Native browser redirects preserve HTTP methods and cookies; UI actions are not replayed. Normal SPA navigation is supported. Subresources such as CDN scripts are not subject to the document-navigation allowlist. External identity-provider navigation is permitted only during separate authentication or the guided login/discovery phase.

## Reuse a plan

A run with a resolved profile saves the validated `plan.json` beside `report.md` and returns `planPath`. Review the declared build reference, readiness, requirement and record preconditions before reusing it. The saved plan does not prove that a new build has been deployed or reset existing records.

```json
{
  "action": "run",
  "planPath": "C:/path/to/.d365fo-ui/reports/RUN-ID/plan.json",
  "timeouts": { "navigationTimeoutMs": 120000, "caseTimeoutMs": 300000 }
}
```

Supply exactly one of `plan` or `planPath`. Saved input files are capped at 2 MiB and validated again. A plan does not embed credentials or the profile; supply the same `profilePath` when an override is needed. This supports lightweight repetition of these cases; it is not a Task Recorder/RSAT suite importer.

## Read the report

The response gives the overall result, the case outcomes, a bounded journey with expected/observed evidence, and the report/plan paths. The Markdown report records the requirement, declared build, environment/company, effective timeouts, duration, actual steps completed, expected and observed values, and the stopping point. An error screenshot is local and optional; it is not sent to a model.

| Outcome | Meaning |
|---|---|
| PASS | All assertions matched, with no recognized system error and no incomplete system-error inspection. |
| FAIL | An observed functional result contradicted the requirement, or a recognized D365 system error appeared after an application action. |
| NOT_VERIFIED | Missing session/build readiness, unmet precondition, ambiguous selector, navigation/action error or another technical block prevented a verdict. |

Overall FAIL takes precedence over NOT_VERIFIED, and NOT_VERIFIED over PASS. Always inspect the individual outcomes. An expected business rejection is a **passing negative case** if the expected rejection actually appears.

### Independent D365 system-error evidence

Both modes inspect visible application dialogs/alerts for the Italian and English menu-item-open error and multiple-system-errors messages (for example, “Impossibile aprire l'oggetto menu item” and “Più errori ricevuti”). Inspection runs outside the truncated observation snapshot, around actions and at result collection. It covers visible same-origin frames and open shadow roots. It does not classify generic business warnings as platform errors, use a model, dismiss a dialog or retry an action.

`systemErrors` in the response and the **System errors** section of the report retain the error code, canonical description, time and whether it appeared before or after an application action. Raw dialog contents are not copied. Once observed, evidence survives dismissal and cannot be overwritten by a passing criterion. A post-action platform error makes that case FAIL independently of its declared checks; an error already present before its first action blocks the case with NOT_VERIFIED. Existing criterion failures and the WRITE_UNCERTAIN interaction state remain intact. `systemErrorInspectionIncomplete` prevents a PASS if the bounded inspection could not complete.

This detects the listed DOM signatures, not every possible D365 error or a proven causal link to the generated code. Other languages, closed shadow roots and transient dialogs between observations still need live verification. For an expected missing-record guard in an action menu item's `static void main(Args ...)`, request `get_knowledge` topic `menu-item-guards`: `validate_code` now emits advisory `UI001` for recognizable unhandled `throw error(...)` patterns. Use `warning()` plus `return` only for ordinary guard outcomes; preserve exceptions needed for rollback, security and batch failures.

## Validation scope

### Retest after the dev feedback fixes

Update the checkout, run `npm ci` and `npm run build`, then restart the local MCP. Configure `environment.uiBrowserChannel` as `msedge` on a dev machine that requires Edge. Fetch the guided contract again.

1. Verify the existing order `G000260436` with a criterion declared `check:"value"` on its native field; expect PASS if that value is present. A separate deliberately incompatible `text` check must give `CHECK_NOT_APPLICABLE` / NOT_VERIFIED, never FAIL.
2. Verify the empty-result alert with `check:"text"` and its observed exact text (or `match:"contains"` for additional message text), scoped to the intended grid. Compare against a deliberately different expected message to confirm a genuine mismatch still produces FAIL.
3. Repeat human login in Edge. If it fails, return the tool's safe `diagnostic` and message: they report phase/code, attempted browser and blocked origin where applicable, excluding URL paths, query tokens, browser logs and credentials. Report files include the actual browser choice and available stopping reason.

Do not replay an uncertain write merely to repeat this acceptance check. The default is now 30 calls per case; reduce `limits.calls` when a shorter test suffices and prefer scoped observations. Measured `rowCount` is available with explicit rendered/total semantics above. Automatic active-form selection and dedicated column-filter actions remain outside this release.

Run the browser fixture checks with `npm run test:ui` after installing Chromium. Run the input/report tests with `npm run test:run -- tests/tools/verify-ui-customization.test.ts`.

Automated fixture tests exercise guided snapshots, retained references, scope and row identity, password masking, company gates, cancellation, case isolation and the HTTP protocol, as well as Chromium interaction, same-origin and blocked redirects, native POST redirects/cookies, popup blocking, timeout behavior, visible scoping, text matching, saved plans and a simulated identity provider with session reuse. They do not prove compatibility with live D365FO, Edge-specific tenant policies or real Entra ID/MFA. Before relying on this fork for a real customization, run its cases against the deployed D365FO environment and inspect the evidence. Uncovered requirement criteria remain outside the verdict.
