# UI Customization Verification Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User has approved implementation and public fork publication.

**Goal:** Add one local MCP tool that deterministically runs two requirement-based browser cases and writes a concise report.

**Architecture:** A validated JSON contract drives a Playwright runner. The MCP handler exposes `action=contract|run` so the full contract is fetched once instead of sent in every tool catalogue. A local profile owns the test origin, saved browser authentication and artifact directory. The runner contains no LLM calls.

**Tech Stack:** Existing TypeScript/Node 24, Zod, Vitest, Playwright Chromium.

## Chunk 1: Runner and integration

### Task 1: Build the tool with focused tests

Files: create `src/tools/sdlc/uiVerification/{contract,runner,report}.ts`, `src/tools/sdlc/verifyUiCustomization.ts`, `src/server/toolSchemas/verifyUiCustomization.ts`, `tests/tools/verify-ui-customization.test.ts`, `tests/tools/ui-verification.integration.test.ts`.

- [x] Define tests first for exactly two cases, required checks/preconditions, forbidden origins, PASS/FAIL/NOT_VERIFIED aggregation and concise escaped report output. Run with `node node_modules/vitest/vitest.mjs run tests/tools/verify-ui-customization.test.ts` and observe missing behavior before implementation.
- [x] Implement strict Zod contracts: plan requirement/build/company/startUrl, two named cases with executable preconditions, at most 20 structured steps each, at least one functional assertion each. Profile: baseUrl, storageState path, outputDir, optional headless and browser channel. Resolve profile-relative paths. Use CSS locators observed from actual DOM; no eval/code steps. Include company selector and observed company check.
- [x] Implement sequential isolated browser contexts per case, same saved login; actions navigate/click/fill/select/press/wait and assertions visible/text/value/enabled. Enforce exact allowed origin on navigation and redirects, unique targets, 15-second step waits and 120-second case limit. Stop a case at first failure; run second independently. Cancel and close owned browser contexts on timeout/abort so writes cannot continue in background. Missing session/preconditions/actions are NOT_VERIFIED; only observed functional contradictions are FAIL. Do not turn an exception into PASS.
- [x] Save Markdown report with actual completed journey, expected/observed, statuses, duration and declared build reference. Optional error screenshot remains local. Overall FAIL dominates NOT_VERIFIED, which dominates PASS. Never claim the browser independently attested the build or all requirements. Bound observations and escape Markdown.
- [x] MCP `action=contract` returns full schemas and an example. `action=run` accepts profilePath and plan. Handler returns compact summary and report path; no retry or automatic repair. Surface progress and cancellation if supported by existing handler context.
- [x] Add Playwright as dependency and lockfile; install Chromium for fixture validation. Real browser fixture tests prove positive/negative results, technical blockage and isolation. No D365 access is available: do not claim live D365 validation.
- [x] Register appended schema, handler, annotations (mutating/non-idempotent), local and core membership, progress and startup inventory per `docs/NEW_TOOL_CHECKLIST.md`. Update inventory/mode/schema budget tests deliberately; quantify new catalogue bytes instead of embedding the complete plan schema.

### Task 2: Documentation, verification and publication

Files: `docs/UI_CUSTOMIZATION_TESTING.md`, `README.md`, `docs/MCP_TOOLS.md`, registration-related count docs/config, `.github/copilot-instructions.md`, `.gitignore`.

- [x] Document the post-build invocation, two-case contract, first-time saved-login setup using Playwright codegen, concrete example profile/plan, limitations and local report. Ignore `.d365fo-ui/` and `playwright/.auth/`. Do not publish real environment data.
- [x] Run targeted unit/inventory/mode tests, browser fixture integration, `npm run typecheck`, `npm run build`, lint on changed code. Run the repository suite once if feasible; distinguish baseline failures from changes.
- [x] Review spec compliance then code quality. Fix meaningful findings and rerun affected checks.
- [x] Commit and push to `DavideWasTaken/d365fo-mcp-server`, keeping the upstream remote separate. Publish the working change to the user's fork and link it. Do not open a PR against upstream without a request.

## Acceptance

One new discoverable MCP tool; two cases enforced; no LLM dependency; browser-observed evidence; explicit blocked outcomes; simple local report; tests and build evidence. A live D365FO acceptance run remains pending until an environment and real customization are supplied.

## Verification record

- Node 24.19.0: build and typecheck passed.
- Unit suite: 436 files passed, 6,486 tests passed, 3 skipped, with `tests/bridge/formAuthoringDefaults.test.ts` excluded because its unchanged .NET 8 harness cannot compile with the machine’s .NET 7 SDK (NETSDK1045). Initial unfiltered run reproduced this environment limitation.
- Final integration tier: 13 tests passed, 2 skipped, including ten real Chromium fixture tests. The redirect-chain regression first reproduced the escape and now confirms no subsequent redirect hop is requested. Final independent review approved. All HTTP navigation redirects are explicitly unsupported in this MVP.
- Lint: no errors; existing unrelated unused-import warning and Biome schema-version information remain.
- Tool catalogue: 45,560 characters, an increase of 738; full contract is fetched once on demand.
- No live D365FO environment or custom supplied, so live acceptance remains unverified.
