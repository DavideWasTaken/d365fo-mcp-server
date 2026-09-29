# Build status, recovery, and runtime refresh

## Why this fork changes the build workflow

This fork modifies the existing `build_d365fo_project` tool as well as adding UI verification and SQL. In the development VM's previous workflow, MCP compilation could succeed while the running AOS still did not expose newly compiled objects. A new menu item could therefore appear missing in the browser. The workaround used on that VM was a Visual Studio build/runtime refresh or a manual IIS/IIS Express restart.

The missing step was refreshing the running AOS after compilation. With `restartAos:true`, the fork completes the compile, runtime metadata generation and requested database sync, then restarts the matching local AOS host and verifies replacement-process and HTTP readiness. A second Visual Studio compilation is not part of this workflow. If compilation, metadata generation or synchronization itself fails, those errors still need resolving; restarting AOS cannot repair them.

The compiler remains `xppc.exe`. The fork changes how the job runs and how its result reaches the running environment: background execution with recoverable logs/results, requested post-build actions executed once, and an optional runtime restart before UI verification. Restart is opt-in on the initial build request. Without `restartAos:true`, the tool reports that a runtime refresh is still required. A blocked/failed restart or unconfirmed readiness returns a prominent user-action warning, so the client AI must notify the user before continuing to UI tests.

## Start and collect a build

`build_d365fo_project` prepares and compiles in the background by default. It returns the target, compiler PID (or pending while preparing), and a local log path rather than holding the MCP request open through label compilation and the model build. This avoids losing a several-minute build result to a client's request timeout.

Start with the desired actions:

```json
{"modelName":"MyModel","fullBuild":true,"bpCheck":true,"dbSync":["MyTable"],"restartAos":true}
```

Check status and collect the final result using the same model:

```json
{"modelName":"MyModel"}
```

Space status checks apart (for example 15–30 seconds, increasing the interval for long builds) rather than polling in a tight loop. The saved log remains available between calls.

Omit `fullBuild` and `force` when collecting. `fullBuild:true` requests a fresh compilation once the previous build has finished. A source change also invalidates a saved finished result and starts a fresh build. Finished results retain their original timestamp and clearly state that collection compiled nothing. Logs and the latest result remain available until superseded by a new build or removed from the machine's temporary directory.

Set `bpCheck`, `dbSync`, and `restartAos` on the initial request. The original build runs these actions once after successful compilation and saves their output. A database sync or runtime restart failure is an error for the requested workflow even when compilation succeeded. Follow-up calls read saved output; they neither change nor replay the actions, even if flags are repeated or changed. The same applies to recovered queue results; referenced-model queue execution remains disabled.

Keep the MCP server running until finalization completes. Compiler execution, runtime metadata generation, BP checking, database sync, and runtime restart do not constitute a restart-safe job service. If the owning server process exits before it records completion, a later call reports the outcome as unknown and shows the log and the captured request. It does not silently repeat potentially completed mutations. A restart build holds a reservation shared by the MCP processes on the machine: new and forced builds are refused while it is active or its outcome is uncertain. If the server died before the restart stage (compiling, BP check or sync), the next build releases the reservation and says so; if it died during the restart, recovery is manual — see [recovery](AOS_RUNTIME_RESTART.md#readiness-and-failure-reporting). Inspect the host, compiler, and sync outcome before recovering an uncertain job; the response identifies its saved state and log.

`wait:true` remains available for clients that support a long blocking request. `waitTimeoutMs` limits that wait (30 minutes by default); it does not stop compilation, and the client may time out earlier regardless of progress notifications. A later normal status call can recover the result while the server remains running.

## Actual runtime restart before UI tests

A successful compile does not prove that the AOS runtime loaded the new objects. The build-before-UI-test workflow requires `restartAos:true` on the initial build and collection of an `AOS runtime ready` result before starting UI tests. Without that option, successful single-model and recovered queue responses retain the restart advisory. This is a workflow requirement, not a new cross-tool UI session gate.

If restart is blocked, fails, or readiness cannot be verified, the result carries `isError:true` and a prominent **USER ACTION REQUIRED** warning instead of an overall green build heading. The calling AI is explicitly instructed to inform the user of the cause, stop before UI tests, and request manual host inspection/restart if needed plus readiness confirmation. The warning remains on saved-result collection; collecting it never retries the restart. The notification is delivered through the MCP response and client conversation, not a Windows popup.

The environment root is an explicit `aosUrl` on the build, else `D365FO_UI_TEST_URL` (so UI tests and the restart target the same environment), else — on a classic AOSService VM — `Infrastructure.HostUrl` from `AosService\WebRoot\web.config` beside the packages folder. UDE has no local AOS, so there it must come from one of the first two. The result names the root and where it came from, and the host that was restarted. Restart occurs only after runtime metadata generation and any requested database sync succeeded; skipped metadata generation or an empty requested sync scope blocks it. The configured hostname must resolve exclusively to local addresses, and exactly one running host's root application binding must match the URL's scheme, port, host, and local IP binding.

For full IIS, only the matching, running `AOSService` application pool/site is eligible, and the Windows session must be administrative. The tool recycles that pool and verifies a new worker process. A stopped `W3SVC` is not treated as a live full IIS host.

For IIS Express, the tool identifies the specific process from its configuration and binding, verifies the same Windows owner and process identity, checks termination access and elevation compatibility before stopping, and preserves its executable and validated startup arguments. The observed development launch is supported:

```text
"C:\Program Files\IIS Express\IISExpress.exe" /config:"C:\Users\Developer\Documents\IISExpress\config\applicationHost.config" /apppool:Dynamics365
```

An explicit `/site:` or `/siteid:` selector is also supported. Unknown or duplicate arguments, unreadable configuration, foreign ownership, ambiguous matching roots, or unavailable permissions block restart. Immediately before mutation, the tool revalidates configuration, ownership, process identity, DNS locality, and matching binding. It stops only the selected PID, waits for exit, and launches the replacement hidden with the same validated arguments. There is no process-name kill, `iisreset`, arbitrary shell command, or automatic restart retry. Dynamic values are JSON data on stdin to a constant PowerShell program.

Readiness is bounded to 180 seconds after restart and requires both replacement process/pool verification and an HTTP response from the configured environment. It follows at most five same-origin redirects and never follows external redirects. A 2xx response or expected authentication challenge (401 or HTTPS `login.microsoftonline.com`/`login.windows.net`) establishes host readiness; the response explicitly says sign-in is still required in the browser. Unexpected external redirects, redirect loops, process failures, and unavailable HTTP responses produce `not-ready` or `failed`, not a deploy-success claim. Object availability and business behavior still require the independent UI checks.

For command semantics, see Microsoft's [IIS Express command-line documentation](https://learn.microsoft.com/en-us/iis/extensions/using-iis-express/running-iis-express-from-the-command-line), [Start-Process argument/hidden-window documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process), and [Restart-WebAppPool](https://learn.microsoft.com/en-us/powershell/module/webadministration/restart-webapppool). The `/apppool:Dynamics365` case is additionally grounded in the development-machine process evidence above.

Local regressions cover async launch/collection, source freshness, single/queued results, post-build sequencing/no replay, failed prerequisites, uncertain recovery, and force/restart races. Runtime tests cover host selection, readiness, and a Windows PowerShell harness with every restart mutation mocked, including the exact `/config` + `/apppool` arguments and hidden launch. No local AOS host is stopped by those tests. The restart path was tested live with IIS Express (this fork, 2026-09-26 and 2026-09-28) and with the IIS AOSService pool (upstream maintainer, PR #1046); see [validation status](TESTING.md#fork-validation-status).
