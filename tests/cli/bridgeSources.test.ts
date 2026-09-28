/**
 * Whether the built bridge matches the sources on disk.
 *
 * `update` used to judge that by diffing HEAD across its own `git pull`, which
 * missed a hand-run pull and a pull whose npm install or build then failed —
 * the next run saw an empty diff and offered the rebuild as a nicety. The build
 * now stamps its sources next to the binary (WriteBridgeSourceStamp in the
 * csproj) and this compares against the sources as they are now.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeFreshness, hashBridgeSources, SOURCE_STAMP_FILE } from '../../src/cli/bridgeSources.js';
import { checkBridgeFreshness } from '../../src/cli/commands/doctor.js';
import { hashSources } from '../../scripts/bridgeAttest.mjs';

describe('hashBridgeSources', () => {
  it('computes the same hash as the build attestation', () => {
    // The csproj stamp, this port and bridgeAttest.mjs must agree, or a
    // freshly built bridge would read as stale.
    expect(hashBridgeSources()).toBe(hashSources().hash);
  });
});

describe('bridgeFreshness', () => {
  let root: string;
  let project: string;
  let exe: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'bridge-freshness-'));
    project = join(root, 'bridge', 'D365MetadataBridge');
    fs.mkdirSync(join(project, 'Services'), { recursive: true });
    fs.writeFileSync(join(project, 'D365MetadataBridge.csproj'), '<Project />\n');
    fs.writeFileSync(join(project, 'Services', 'A.cs'), 'class A {}\n');
    const out = join(project, 'bin', 'Release');
    fs.mkdirSync(out, { recursive: true });
    exe = join(out, 'D365MetadataBridge.exe');
    fs.writeFileSync(exe, '');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const stamp = (sourceHash: string) =>
    fs.writeFileSync(join(project, 'bin', 'Release', SOURCE_STAMP_FILE), JSON.stringify({ sourceHash }));

  it('is current when the stamp matches the sources', () => {
    stamp(hashBridgeSources(project, root));
    expect(bridgeFreshness(exe, project, root)).toBe('current');
  });

  it('is stale when a source changed after the build, however it got there', () => {
    stamp(hashBridgeSources(project, root));
    fs.writeFileSync(join(project, 'Services', 'A.cs'), 'class A { int x; }\n');
    expect(bridgeFreshness(exe, project, root)).toBe('stale');
  });

  it('is stale when a source file was added', () => {
    stamp(hashBridgeSources(project, root));
    fs.writeFileSync(join(project, 'Services', 'B.cs'), 'class B {}\n');
    expect(bridgeFreshness(exe, project, root)).toBe('stale');
  });

  it('ignores build output and line-ending churn', () => {
    stamp(hashBridgeSources(project, root));
    fs.mkdirSync(join(project, 'obj'), { recursive: true });
    fs.writeFileSync(join(project, 'obj', 'Generated.cs'), 'class G {}\n');
    fs.writeFileSync(join(project, 'Services', 'A.cs'), 'class A {}\r\n');
    expect(bridgeFreshness(exe, project, root)).toBe('current');
  });

  it('is unknown for a bridge built before stamping existed', () => {
    expect(bridgeFreshness(exe, project, root)).toBe('unknown');
  });

  it('is unknown for an unreadable stamp or a missing binary', () => {
    fs.writeFileSync(join(project, 'bin', 'Release', SOURCE_STAMP_FILE), '{ not json');
    expect(bridgeFreshness(exe, project, root)).toBe('unknown');
    expect(bridgeFreshness(join(root, 'missing.exe'), project, root)).toBe('unknown');
  });
});

describe('doctor — bridge freshness', () => {
  it('warns with the rebuild command when the bridge is stale', () => {
    const result = checkBridgeFreshness('C:\\b\\D365MetadataBridge.exe', 'stale', 'dotnet build -c Release');
    expect(result.severity).toBe('warn');
    expect(result.fix).toContain('dotnet build -c Release');
    expect(result.fix).toContain('stop MCP');
  });

  it('does not claim a match it cannot check', () => {
    const result = checkBridgeFreshness('C:\\b\\D365MetadataBridge.exe', 'unknown', 'x');
    expect(result.severity).toBe('ok');
    expect(result.message).toContain('unknown');
    expect(result.message).not.toContain('matches its sources');
  });

  it('says so when the bridge matches', () => {
    expect(checkBridgeFreshness('C:\\b\\D365MetadataBridge.exe', 'current', 'x').message).toContain('matches its sources');
  });
});
