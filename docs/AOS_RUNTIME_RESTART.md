# Optional AOS restart after a build

On a Windows development environment, successful compilation and runtime metadata generation do not guarantee that the running AOS has loaded the new objects. A newly compiled menu item can remain unavailable in the browser until the runtime is refreshed. `build_d365fo_project` can perform that refresh when explicitly requested, avoiding a separate manual IIS/IIS Express restart.

## Request the restart with the build

```json
{
  "modelName": "MyModel",
  "restartAos": true
}
```

On a classic AOSService VM the environment root comes from the local AOS itself: `Infrastructure.HostUrl` in `AosService\WebRoot\web.config`, beside the `PackagesLocalDirectory` the build uses. The build log records the root and the file it came from. Pass `aosUrl` to override it, and on UDE, which has no local AOS and so no such file:

```json
{
  "modelName": "MyModel",
  "restartAos": true,
  "aosUrl": "https://your-local-development-environment/"
}
```

`aosUrl` is the environment root, not the MCP endpoint or a menu item URL. The restart uses it to choose the one local IIS/IIS Express host whose binding matches it, and then polls it to confirm the AOS answers again. Add `dbSync: true` or an explicit table list when database synchronization is needed. Supply these options on the initial build request. The existing `wait: true` default is unchanged; `wait: false` lets the client collect the result later.

Omitting `restartAos` preserves the existing build workflow. This feature does not require a browser tool or browser configuration.

## Prerequisites and host selection

The restart requires successful compilation, runtime metadata generation and any requested database synchronization. A skipped or failed metadata step, or an unsuccessful requested sync, prevents the restart.

The environment hostname must resolve exclusively to local addresses and match exactly one root application binding. Supported hosts are:

- **IIS:** the running `AOSService` application pool. The MCP process must have administrative privileges.
- **IIS Express:** an instance owned by the MCP process's Windows user, launched from the installed IIS Express executable. Its process identity, configuration and original arguments are checked before stopping it; only the selected instance is restarted, with its original arguments and a hidden window.

For example, this IIS Express launch is supported:

```powershell
& "C:\Program Files\IIS Express\IISExpress.exe" /config:"C:\Users\Developer\Documents\IISExpress\config\applicationHost.config" /apppool:Dynamics365
```

Explicit `/site` and `/siteid` selectors are also supported. Ambiguous matches, changed configuration, insufficient permissions and unsupported launch arguments block the operation with an explanation. The tool does not run a machine-wide `iisreset` or stop unrelated IIS Express instances. IIS Express detection does not depend on the classic IIS service being active.

## Readiness and failure reporting

After restart, the tool checks for a replacement worker and polls the environment for up to 180 seconds. It follows at most five redirects within the environment's origin. A successful HTTP response, an authentication challenge, or an HTTPS redirect to the recognized Entra login hosts can establish host readiness after the replacement process is verified; external redirects are not followed.

Results distinguish `ready`, `blocked`, `failed` and `not-ready`. A restart problem is reported explicitly so the user knows a manual runtime refresh or investigation may be needed. HTTP readiness does not prove that a customization meets its requirement: inspect or test the new objects separately.

The original restart request and its outcome are retained. Collecting a completed build result does not repeat the restart or its prerequisite database synchronization. Interrupted or uncertain restart work is not retried automatically. An overlapping build is blocked while that work is active or uncertain.

This coordination covers MCP processes sharing the same temporary directory, normally those running under the same Windows user. It does not coordinate builds under other Windows accounts or external tools. Finish any Visual Studio builds or other external compilation/synchronization jobs before requesting a restart.

If an interrupted workflow leaves an uncertain reservation, recovery is manual: stop the MCP server, confirm that no build, sync or restart is still active, and inspect the runtime and saved build result. Only after resolving the uncertainty, remove the reservation file identified in the warning (`d365build_aos_restart.json` in the process's temporary directory). Restart the MCP server and request a fresh build with `fullBuild: true` and the desired restart options. Do not remove the reservation merely because it is old.

## Verification

Automated tests cover host selection, local-address restrictions, launch arguments, readiness, build prerequisites and result collection. The Windows PowerShell harness mocks process mutations; these tests do not restart a live AOS.

The originating fork's build-to-UI workflow was confirmed on a development VM running IIS Express with `/config` and `/apppool:Dynamics365`. This isolated upstream integration is tested separately and does not imply live verification of every IIS configuration.
