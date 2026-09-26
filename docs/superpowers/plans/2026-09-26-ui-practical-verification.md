# Practical browser verification

Approved direction: user said proceed after review of redirects, authentication, timeouts, contains, active-form scoping, flexible cases and reusable plans. Work directly on the user's main branch and publish there. No additional approval gate is needed.

## Design and acceptance

- Keep deterministic assertions and no LLM calls in runner; no automatic retry of cases/actions.
- Accept 1..5 cases, recommend two. Preserve readiness/company checks and report every supplied case.
- Text assertions support optional match=exact|contains (exact default); value assertions remain exact. Empty contains is invalid. Each case optionally specifies a CSS scope. Actions target exactly one visible element in that visible scope; hidden/absent visibility assertions remain meaningful and ambiguity never picks the first row.
- Profile and per-run timeouts: step 30s (max120s), navigation 60s (max180s), case180s (max600s). Internal test overrides can lower them. Navigation uses its own budget. Stop on cancellation/deadline without replay.
- Navigation guard uses Chromium CDP Fetch Document interception, before each request, so same-origin redirects work and every intermediate hop is validated. Bound redirect chains (10). Chromium and installed Edge supported. Never follow an external navigation during verification. Unexpected popups stop the affected case (or authentication action); other independent cases still verify their own preconditions. Preserve native HTTP method/cookie behavior.
- Separate authenticate action opens an owned visible browser, allows the environment and exact configured authentication origins (default https://login.microsoftonline.com). Human completes login/MFA. Return to environment plus unique visible companySelector matching requested company is required before saving cookies/localStorage/IndexedDB. Timeout default180s/max300s. No personal profile access, no credentials in tool input, no automatic login during run. Save state atomically; leave existing state unchanged on failure/cancel. Document unsupported popups/federation origins and sessionStorage-only policies.
- Run accepts exactly one of inline plan or local planPath; load/validate JSON (size bounded). Each run saves its validated plan next to report for reuse. Saved build readiness/data preconditions must be reviewed before re-running. Secrets and plans stay local.
- Compact tools/list schema remains within existing budget, full input/plan/profile schemas via contract. Report supports 1..5 cases while staying valid JSON under20k and linking full evidence.

## Chunk 1: Contracts and runner

Root updates contract.ts, report.ts, tool wrapper/catalog and unit tests. Runner implementer owns runner.ts, new navigation.ts/locators.ts and browser integration tests. Add failing cases for same-origin/mixed redirect chains, 1/3/5 cases, contains, duplicate hidden controls, scoped visible forms, larger configured timeout, cancel and no extra writes. Resolve timeout races that could mislabel functional FAIL as NOT_VERIFIED.

## Chunk 2: Login and reuse

Root adds authenticate.ts and a real-browser simulated identity-provider integration test (human login simulated only by fixture pages). Cover state save/load, rejected foreign hop, timeout, cancellation, preservation of old auth. Tests may lower timeouts/headless through internal options; public action always visible. Use shared navigation guard after its contract is stable. Add planPath validation and run plan persistence in runner.

## Chunk 3: Review and release

Update README, UI guide, tool catalog and relevant guidance. Run Node24 npm build, targeted unit and browser tests, catalog budget, then full unit suite excluding the known baseline .NET8-dependent form helper on this SDK7 machine. Do not run CPU-heavy unit suite concurrently with tight browser timing tests. Review diff and actual browser behavior, fix findings, commit/push main. Real D365/Entra VM validation still required; no claim that local fixture tests prove it.

## Validation completed

- Node 24 build passed; full repository lint passed with a pre-existing unused-import warning and Biome schema-version advisory.
- Unit suite: 444 files passed, 6,517 tests passed and 3 skipped. Only `tests/bridge/formAuthoringDefaults.test.ts` excluded for the pre-existing .NET 8 requirement on this SDK 7 machine.
- Full integration tier: 36 tests passed and 2 skipped, including 33 UI/authentication checks. Browser fixture execution used one worker.
- Confirmed failing regressions before fixes for same-origin redirect rejection, popup requests escaping the page event, out-of-process iframe redirect bypass and normal iframe-detach false failure. Native POST/cookie behavior and no action replay are covered.
- Independent code review completed; iframe lifecycle finding fixed and re-reviewed. README and tool documentation updated. Real D365FO/Entra/Edge tenant acceptance remains pending.
