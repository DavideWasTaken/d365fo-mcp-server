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
      'Build a D365FO model with xppc.exe (compiles the ENTIRE model, not one project). ' +
      'Blocks until done — call ONCE per build, do NOT poll (wait:false = legacy polling mode). ' +
      'fullBuild:true fixes "not been successfully compiled since it was last changed" stale-symbol errors.',
    inputSchema: {
      type: 'object',
      properties: {
        modelName: {
          type: 'string',
          description: 'D365FO model name to build (e.g. MyCustomModel). Auto-detected from workspace if omitted.',
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
          description: 'Full recompile of the TARGET model only (deps stay incremental). Use when xppc reports stale symbol errors.',
        },
        bpCheck: {
          type: 'boolean',
          description: 'On a SUCCESSFUL build, append best-practice findings in this call.',
        },
        dbSync: {
          type: ['boolean', 'array'],
          items: { type: 'string' },
          description: 'On a SUCCESSFUL build, sync; REQUIRED for table/view/entity changes. true = project objects (full model if none); an array names exact tables/views.',
        },
        restartAos: {
          type: 'boolean',
          description: 'Opt in to one local IIS/IIS Express AOS restart after compile, runtime metadata and requested sync succeed. Requires aosUrl.',
        },
        aosUrl: {
          type: 'string',
          description: 'Explicit HTTP(S) environment root for restartAos; no credentials, query or fragment.',
        },
        wait: {
          type: 'boolean',
          description: 'Default true: wait for completion in one call. false: return now and collect the result later.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Maximum time (ms) to block when wait:true before returning a "still running" snapshot. Defaults to 30 minutes. The build itself continues in the background.',
        },
      },
      required: [],
    },
  };
