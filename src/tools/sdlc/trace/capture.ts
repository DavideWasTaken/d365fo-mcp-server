/**
 * ETW capture with logman: one session at a time, named SESSION, written straight to an .etl file.
 *
 * The session is a real-time ("-ets") one, so nothing persists in the Data Collector Sets and the
 * file name is exactly the one passed. logman itself stops it when the file reaches the size limit
 * (-max); the duration limit is ours — a timer in this process plus a deadline in the state file,
 * checked on every call, so a capture outlives neither its time nor a restart of the server.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { traceStateDir } from '../../../config/trace.js';

export const SESSION = 'd365fo-mcp-trace';

/** Providers and keywords: X++ method enter/exit, and the AOS Database keyword (SQL latency). */
const PROVIDERS = [
  // Microsoft-Dynamics-AX-XppExecutionTraces: ImplicitTraces (method enter/exit)
  '{C0D248CE-634D-426B-9E31-5A50A6D83024} 0x1 5',
  // Microsoft-Dynamics-AX-ExecutionTraces: Database (statement, bind and fetch latency)
  '{70560195-BECD-45D4-AC93-97290953AD02} 0x10 5',
];

/** Volume measured on a busy batch server: about 45 MB/s; the margin keeps the drive usable. */
const MB_PER_SECOND = 50;
const MARGIN_MB = 1024;

export interface CaptureState {
  file: string;
  outputDir: string;
  mode: 'auto' | 'manual';
  label?: string;
  startedAt: string;
  deadline: string;
  maxSizeMB: number;
  stoppedAt?: string;
  stopReason?: 'stop' | 'time limit' | 'size limit or ended outside MCP';
}

const stateFile = () => join(traceStateDir(), 'trace-session.json');

export function readState(): CaptureState | undefined {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) as CaptureState; } catch { return undefined; }
}
export function writeState(state: CaptureState): void {
  fs.mkdirSync(dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

export interface LogmanResult { code: number; output: string }

export function logman(args: string[]): Promise<LogmanResult> {
  return new Promise(done => {
    execFile('logman', args, { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
      done({ code, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || String(error?.message ?? '') });
    });
  });
}

export const accessDenied = (r: LogmanResult) => /0x80070005|access is denied|accesso negato/i.test(r.output);

export async function isSessionRunning(): Promise<boolean> {
  return (await logman(['query', SESSION, '-ets'])).code === 0;
}

/** Free bytes on the volume of path (the nearest existing ancestor), or undefined. */
export function freeBytes(path: string): number | undefined {
  let dir = resolve(path);
  for (;;) {
    try {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  }
}

export function listDrives(): Array<{ drive: string; freeGB: number }> {
  const drives: Array<{ drive: string; freeGB: number }> = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      const s = fs.statfsSync(root);
      drives.push({ drive: root, freeGB: Math.round((Number(s.bavail) * Number(s.bsize)) / 2 ** 30 * 10) / 10 });
    } catch { /* no such drive */ }
  }
  return drives.sort((a, b) => b.freeGB - a.freeGB);
}

/** Size limit for one capture: enough for the time asked, never more than the setup allows. */
export function sizeLimitMB(seconds: number, maxSizeMB: number): number {
  return Math.max(200, Math.min(maxSizeMB, seconds * MB_PER_SECOND));
}
export const requiredFreeMB = (limitMB: number) => limitMB + MARGIN_MB;

export function captureFileName(dir: string, label: string | undefined, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return join(dir, `d365fo-${stamp}${label ? `-${label}` : ''}.etl`);
}

export async function startCapture(file: string, limitMB: number): Promise<LogmanResult> {
  const providers = join(dirname(file), `${SESSION}.providers.txt`);
  fs.writeFileSync(providers, `${PROVIDERS.join('\r\n')}\r\n`);
  try {
    return await logman(['create', 'trace', SESSION, '-pf', providers, '-o', file,
      '-bs', '512', '-nb', '256', '256', '-max', String(limitMB), '-ets']);
  } finally {
    fs.rmSync(providers, { force: true });
  }
}

export async function stopCapture(): Promise<LogmanResult> {
  return logman(['stop', SESSION, '-ets']);
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Stop at the deadline even if nobody calls the tool again. */
export function armTimer(state: CaptureState): void {
  if (timer) clearTimeout(timer);
  const ms = Math.max(0, Date.parse(state.deadline) - Date.now());
  timer = setTimeout(() => { void settleExpired(); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Bring the state file in line with the machine: past its deadline → stop it; no longer
 * running (size limit reached, stopped by hand) → record that. Returns the current state.
 */
export async function settleExpired(): Promise<CaptureState | undefined> {
  const state = readState();
  if (!state || state.stoppedAt) return state;
  const running = await isSessionRunning();
  if (running && Date.now() < Date.parse(state.deadline)) return state;
  if (running) await stopCapture();
  state.stoppedAt = new Date().toISOString();
  state.stopReason = running ? 'time limit' : 'size limit or ended outside MCP';
  writeState(state);
  if (timer) { clearTimeout(timer); timer = undefined; }
  return state;
}

export function clearTimer(): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
}

/** Whether file lies inside dir (case-insensitive, as on Windows). */
export function isInside(file: string, dir: string): boolean {
  const f = resolve(file).toLowerCase();
  const d = resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
  return f.startsWith(`${d}\\`) || f.startsWith(`${d}/`);
}

export function captures(dir: string): Array<{ file: string; sizeMB: number; modified: string }> {
  try {
    return fs.readdirSync(dir)
      .filter(n => /\.etl$/i.test(n))
      .map(n => { const s = fs.statSync(join(dir, n)); return { file: join(dir, n), sizeMB: Math.round(s.size / 2 ** 20), modified: s.mtime.toISOString() }; })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

export const driveOf = (path: string) => parse(resolve(path)).root;
