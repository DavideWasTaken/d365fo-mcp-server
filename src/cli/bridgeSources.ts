/**
 * Whether the built C# bridge was compiled from the sources now on disk.
 *
 * `git pull` — or an npm update — can move the bridge sources while leaving the
 * deployed binary in place, and then nothing says the binary is older than its
 * code: the server keeps running the previous build, without the fixes the pull
 * brought. Diffing HEAD across one `update` run misses a hand-run `git pull`,
 * and a pull whose `npm install` or build then failed (the next run sees an
 * empty diff). So the build itself records what it compiled: the
 * WriteBridgeSourceStamp target in D365MetadataBridge.csproj writes
 * D365MetadataBridge.sources.json next to the binary, and this compares it with
 * the sources as they are now.
 *
 * The hash is the one scripts/bridgeAttest.mjs computes — same files, same
 * order, CRLF normalised — ported here because that script is not part of the
 * npm package.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { paths, repoRoot } from './context.js';

const SOURCE_EXTENSIONS = ['.cs', '.csproj'];
const SKIP_DIRS = new Set(['obj', 'bin']);
export const SOURCE_STAMP_FILE = 'D365MetadataBridge.sources.json';

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectSources(join(dir, entry.name)));
    } else if (SOURCE_EXTENSIONS.some(e => entry.name.endsWith(e))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Hash of the bridge compiler's inputs, identical to bridgeAttest.mjs's hashSources. */
export function hashBridgeSources(dir: string = paths.bridgeDir, root: string = repoRoot): string {
  const digest = createHash('sha256');
  for (const file of collectSources(dir).sort()) {
    const rel = relative(root, file).split(sep).join('/');
    const content = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
    digest.update(`${rel}:${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return digest.digest('hex');
}

/**
 *   current — the binary was built from exactly these sources
 *   stale   — the sources changed after the binary was built
 *   unknown — no binary, or one built before stamping existed (or an unreadable stamp)
 */
export type BridgeFreshness = 'current' | 'stale' | 'unknown';

export function bridgeFreshness(
  exePath: string = paths.bridgeExe,
  dir: string = paths.bridgeDir,
  root: string = repoRoot,
): BridgeFreshness {
  try {
    if (!fs.existsSync(exePath)) return 'unknown';
    const stampPath = join(dirname(exePath), SOURCE_STAMP_FILE);
    if (!fs.existsSync(stampPath)) return 'unknown';
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as { sourceHash?: unknown };
    if (typeof stamp.sourceHash !== 'string' || stamp.sourceHash.length === 0) return 'unknown';
    return stamp.sourceHash === hashBridgeSources(dir, root) ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}
