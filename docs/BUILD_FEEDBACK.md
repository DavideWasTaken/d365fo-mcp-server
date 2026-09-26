# Build status, recovery, and runtime refresh

`build_d365fo_project` prepares and compiles in the background by default. It returns the target, compiler PID (or pending while preparing), and a local log path rather than holding the MCP request open through label compilation and the model build. This avoids losing a several-minute build result to a client's request timeout.

Start with the desired actions:

```json
{"modelName":"MyModel","fullBuild":true,"bpCheck":true,"dbSync":["MyTable"]}
```

Check status and collect the final result using the same model:

```json
{"modelName":"MyModel"}
```

Space status checks apart (for example 15–30 seconds, increasing the interval for long builds) rather than polling in a tight loop. The saved log remains available between calls.

Omit `fullBuild` and `force` when collecting. `fullBuild:true` requests a fresh compilation once the previous build has finished. A source change also invalidates a saved finished result and starts a fresh build. Finished results retain their original timestamp and clearly state that collection compiled nothing. Logs and the latest result remain available until superseded by a new build or removed from the machine's temporary directory.

Set `bpCheck` and `dbSync` on the initial request. The original build runs these actions once after successful compilation, saves their output, and reports a database sync failure separately from compilation success. Follow-up calls read saved output; they neither change nor replay the actions, even if flags are repeated or changed. The same applies to recovered queue results; referenced-model queue execution remains disabled.

Keep the MCP server running until finalization completes. Compiler execution, runtime metadata generation, BP checking, and database sync do not constitute a restart-safe job service. If the owning server session ends before it records completion, a later call reports the outcome as unknown and shows the log and captured request. It does not silently repeat a potentially completed database sync. Inspect the compiler and sync outcome before deliberately restarting a build with `force:true`.

`wait:true` remains available for clients that support a long blocking request. `waitTimeoutMs` limits that wait (30 minutes by default); it does not stop compilation, and the client may time out earlier regardless of progress notifications. A later normal status call can recover the result while the server remains running.

## Compilation and runtime availability

A successful compile does not prove that the AOS runtime loaded the new objects. Successful single-model and recovered queue responses explicitly advise restarting/reloading the actual runtime host before testing new or changed objects, and keep the compiler log paths visible.

For a full IIS environment, recycle the `AOSService` application pool through normal environment operations. For IIS Express, restart the specific IIS Express instance hosting that environment through its normal launcher. A stopped `W3SVC` service does not identify or restart the IIS Express host. The build tool does not detect, kill, or restart runtime host processes automatically. Verify object availability after refresh, and still inspect any runtime metadata generation or database sync failure.

Local regression coverage uses mocked compiler/process/filesystem boundaries: default launch and follow-up, explicit waits, success/failure logs, single/queued rendering, captured post-build actions, repeated collection without replay, interrupted server sessions, and source freshness. An actual D365FO build, sync, and IIS Express refresh must be verified on the development environment.
