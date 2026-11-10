/**
 * MCP tool definition for `build_d365fo_project` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 *
 * `dbSync` was folded in from the retired `trigger_db_sync` tool, mirroring the
 * `bpCheck` precedent exactly: a sync always follows a successful build, so the
 * knob belongs on the build rather than costing a second round trip and a
 * second published schema. A partial sync with NO rebuild (a modify-only
 * session) stays reachable through the still-routable `trigger_db_sync` name.
 *
 * `deploy` follows the same precedent for UDE, where tests run in the cloud
 * runtime against deployed code: a deployment always follows a successful build.
 * `wait` and `waitTimeoutMs` are kept short because the tool description already
 * says the call blocks until done.
 */

export const buildD365foProjectTool = {
    name: 'build_d365fo_project',
    description:
      'Compile a D365FO model with xppc.exe in background. Collect with modelName only; wait:true blocks. fullBuild:true recompiles stale symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        modelName: {
          type: 'string',
          description: 'Model to build; defaults to workspace model.',
        },
        // projectPath is NOT published: it was self-described "(Legacy)" and its
        // only job is deriving a model name that `modelName` states directly.
        // The handler still accepts it.
        force: {
          type: 'boolean',
          description: 'Kill any running build processes for this model and restart.',
        },
        fullBuild: {
          type: 'boolean',
          description: 'Full recompile of TARGET model (not deps). Fixes stale symbols; auto when an entity with OData actions changes.',
        },
        bpCheck: {
          type: 'boolean',
          description: 'Run best practices once after a SUCCESSFUL build. Set initially; status calls collect saved findings.',
        },
        dbSync: {
          type: ['boolean', 'array'],
          items: { type: 'string' },
<<<<<<< HEAD
          description: 'Sync once after a SUCCESSFUL build. Required for table/view/entity changes. true=project scope (model if none); ARRAY=exact tables/views. Set initially.',
=======
          description: 'On a SUCCESSFUL build, also run the database sync (SyncEngine.exe) — REQUIRED after any table/view/data-entity change. true = partial sync of the syncable objects in the project, full-model when it has none; an ARRAY syncs exactly those tables/views (much faster). With deploy: full sync in the environment.',
        },
        deploy: {
          type: 'boolean',
          description: 'UDE: on a SUCCESSFUL build, deploy the model\'s package to the cloud runtime that run_systest_class tests run in. No DB sync (~3 min) unless dbSync (~20 min).',
>>>>>>> 289cfc304d0f20ce35e96389324acefdafc5d861
        },
        restartAos: {
          type: 'boolean',
          description: 'Restart the matched local AOS host once after metadata/sync success, then verify host/HTTP readiness. Status calls never replay restart.',
        },
        aosUrl: {
          type: 'string',
          description: 'Environment root for restartAos. Defaults to Infrastructure.HostUrl from the local AosService\\WebRoot\\web.config (none on UDE). Must uniquely match a local IIS/IIS Express host.',
        },
        wait: {
          type: 'boolean',
<<<<<<< HEAD
          default: false,
          description: 'False returns status/log. wait:true blocks; client timeout may be shorter. Keep the MCP server running.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Blocking limit for wait:true, default 30 minutes. Timeout leaves the build running.',
=======
          description: 'Default true: one call returns the final result. false = legacy fire-and-forget.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Max ms to block (default 30 min) before a "still running" snapshot; the build continues.',
>>>>>>> 289cfc304d0f20ce35e96389324acefdafc5d861
        },
      },
      required: [],
    },
  };
