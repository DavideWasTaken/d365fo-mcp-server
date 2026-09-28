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
          description: 'Recompile the target model fully; fixes stale symbols. Omit on status calls.',
        },
        bpCheck: {
          type: 'boolean',
          description: 'Run best practices once after a SUCCESSFUL build. Set initially; status calls collect saved findings.',
        },
        dbSync: {
          type: ['boolean', 'array'],
          items: { type: 'string' },
          description: 'Sync once after a SUCCESSFUL build. Required for table/view/entity changes. true=project scope (model if none); ARRAY=exact tables/views. Set initially.',
        },
        restartAos: {
          type: 'boolean',
          description: 'Required true for build-before-UI tests: restart the matched local AOS host once after metadata/sync success, then verify host/HTTP readiness. Status calls never replay restart.',
        },
        aosUrl: {
          type: 'string',
          description: 'Environment root for restartAos. Defaults to D365FO_UI_TEST_URL, then Infrastructure.HostUrl from the local AosService\\WebRoot\\web.config (none on UDE). Must uniquely match a local IIS/IIS Express host.',
        },
        wait: {
          type: 'boolean',
          default: false,
          description: 'False returns status/log. wait:true blocks; client timeout may be shorter. Keep the MCP server running.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Blocking limit for wait:true, default 30 minutes. Timeout leaves the build running.',
        },
      },
      required: [],
    },
  };
