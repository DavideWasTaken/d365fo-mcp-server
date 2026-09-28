/**
 * `d365fo-mcp update [--yes]` — bring the installation to the latest release,
 * then optionally rebuild the C# bridge and the metadata index.
 *
 * How the code is refreshed depends on how it was installed: a checkout runs
 * the "Update" flow SETUP.md documents (git pull && npm install && npm run
 * build); an npm install reinstalls itself from the registry.
 */
import * as fs from 'node:fs';
import { DOTNET_MISSING, bridgeBuildCommand, installMode, isWindows, paths } from '../context.js';
import { bridgeFreshness } from '../bridgeSources.js';
import { commandExists, runExe, runShell } from '../exec.js';
import { branchStatus, changedFiles, gitHead } from '../gitState.js';
import { listInstances } from '../instances.js';
import { checkRelease } from '../npmRegistry.js';
import { instanceTarget, rootTarget } from '../target.js';
import { askConfirm, p, requireFullInstall } from '../ui.js';
import { rebuildIndex } from './indexCmd.js';

/**
 * What to do about the C# bridge after the code has been refreshed.
 *
 * Both inputs are needed, and *when* they are sampled is the whole point.
 * `hadBridge` is taken before the update: judged on the after-state alone, a
 * bridge the update destroyed is indistinguishable from one that was never
 * built, and the difference is whether the server just lost its write path.
 *
 * A third input covers the binary that survives but no longer matches its
 * code. `git pull` never deletes the binary, so for a checkout the two above
 * always read "optional" — even when the pull brought C# fixes, which the old
 * binary then silently goes on without. `sourcesChanged` is whether the bridge
 * sources differ from the ones the binary was built from.
 *
 *   none     — there was no bridge, so this install does not use writes
 *   optional — the bridge survived and its sources did not move; rebuilding
 *              is a post-upgrade nicety
 *   stale    — the bridge survived, but its sources changed after it was
 *              built, so the binary predates them until it is rebuilt
 *   required — the update removed a bridge that was there, so the write path
 *              is gone until it is rebuilt
 */
export type BridgeAction = 'none' | 'optional' | 'stale' | 'required';

export function bridgeAction(hadBridge: boolean, existsNow: boolean, sourcesChanged = false): BridgeAction {
  if (!hadBridge) return 'none';
  if (!existsNow) return 'required';
  return sourcesChanged ? 'stale' : 'optional';
}

/** The bridge project, as a pathspec relative to the repository root. */
const BRIDGE_SOURCES = 'bridge/D365MetadataBridge';

export async function updateCommand(opts: { yes?: boolean }): Promise<void> {
  p.intro('d365fo-mcp update');
  if (!requireFullInstall()) return;

  // Say up front what the update is moving towards. A checkout tracks a branch
  // rather than the registry, and its package.json is only bumped when a
  // release is published — so a registry comparison would call a checkout that
  // already contains the latest release outdated. It names the branch instead.
  if (installMode === 'git') {
    const branch = branchStatus();
    p.log.step(branch
      ? `Git checkout of ${branch.branch} — pulling from ${branch.upstream}.`
      : 'Git checkout — pulling from the branch it tracks.');
  } else {
    const release = await checkRelease();
    if (release.latest === null) {
      p.log.warn(`Running ${release.current} — npm registry unreachable, so this update runs blind.`);
    } else if (release.behind) {
      p.log.step(`Running ${release.current}; latest published release is ${release.latest}.`);
    } else {
      p.log.success(`Running ${release.current} — already the latest published release.`);
      if (!opts.yes && !await askConfirm('Reinstall anyway?', false)) {
        p.outro('Nothing to update.');
        return;
      }
    }
  }

  // Sampled before the update rather than after. The bridge is built outside
  // the package now, so an update should leave it alone — but this is what
  // proves it did: if the binary was there before and is gone after, the
  // update destroyed the write path, and saying so beats reading the absence
  // as "this install never needed writes" and silently moving on.
  const hadBridge = isWindows && fs.existsSync(paths.bridgeExe);
  // Also before: what the pull moved is the diff from here to the new HEAD.
  const headBefore = installMode === 'git' ? gitHead() : null;

  const steps: [string, () => Promise<number>][] = installMode === 'npm'
    ? [['npm install -g d365fo-mcp@latest', () => runShell('npm install -g d365fo-mcp@latest')]]
    : [
      ['git pull', () => runExe('git', ['pull'])],
      ['npm install', () => runShell('npm install')],
      ['npm run build', () => runShell('npm run build')],
    ];
  for (const [label, run] of steps) {
    p.log.step(label);
    if (await run() !== 0) {
      p.log.error(`${label} failed — fix the error above and re-run.`);
      process.exitCode = 1;
      return;
    }
  }

  // The stamp the bridge build writes next to the binary is the reliable
  // answer: it also catches sources that moved before this run — a hand-run
  // `git pull`, or an earlier update whose npm install or build failed. A
  // binary built before stamping existed has none; then fall back to what this
  // pull moved (null when the diff cannot be computed: nothing known changed).
  const freshness = bridgeFreshness();
  const pulledSources = freshness === 'unknown' && headBefore
    ? (changedFiles(headBefore, 'HEAD', BRIDGE_SOURCES) ?? []).length > 0
    : false;
  const action = bridgeAction(hadBridge, fs.existsSync(paths.bridgeExe), freshness === 'stale' || pulledSources);
  if (action !== 'none') {
    const gone = action === 'required';
    const stale = action === 'stale';
    if (gone) p.log.warn('The update replaced the package, so the C# bridge binary is gone — writes stay unavailable until it is rebuilt.');
    if (stale) {
      p.log.warn(
        'The C# bridge sources changed after the bridge was built — ' +
        'those changes are not in effect until it is rebuilt.\n' +
        '   Stop MCP first: a running server keeps the binary locked.',
      );
    }
    const rebuild = opts.yes || await askConfirm(
      gone
        ? 'Rebuild the C# bridge now? (required to restore writes)'
        : stale
          ? 'Rebuild the C# bridge now? (required for the changed bridge sources)'
          : 'Rebuild the C# bridge (recommended after a D365FO version upgrade)?',
    );
    if (rebuild && !await commandExists('dotnet')) {
      p.log.warn(DOTNET_MISSING);
    } else if (rebuild) {
      // Same output directory the wizard used, or the rebuild would land in
      // the package and the configured bridge.exePath would still point at
      // the old binary outside it.
      const buildArgs = ['build', '-c', 'Release', ...(paths.bridgeOutDir ? ['-o', paths.bridgeOutDir] : [])];
      if (await runExe('dotnet', buildArgs, { cwd: paths.bridgeDir }) !== 0) {
        p.log.error(gone
          ? 'Bridge build failed — the server stays read-only until it succeeds.'
          : stale
            ? 'Bridge build failed — MCP keeps running the previous bridge binary, without the source changes.'
            : 'Bridge build failed — writes may use the previous bridge binary.');
        process.exitCode = 1;
        return;
      }
      p.log.success('C# bridge rebuilt.');
    } else if (gone) {
      // Declining is allowed, but it must not be quiet: the capability was
      // there before this command ran and is not there now.
      p.log.warn(`Skipped — the server runs read-only. Rebuild later with:\n   ${bridgeBuildCommand()}`);
    } else if (stale) {
      p.log.warn(`Skipped — MCP keeps running the previous bridge binary, without the source changes. Rebuild later with:\n   ${bridgeBuildCommand()}`);
    }
  }

  if (!opts.yes && await askConfirm('Rebuild the metadata index too? (takes minutes to hours)', false)) {
    const instances = listInstances();
    const targets = instances.length > 0 ? instances.map(instanceTarget) : [rootTarget()];
    for (const target of targets) {
      if (!await rebuildIndex(target)) {
        process.exitCode = 1;
        return;
      }
    }
  }

  p.outro('Update complete.');
}
