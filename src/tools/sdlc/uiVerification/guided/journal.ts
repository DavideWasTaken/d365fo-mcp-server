import { appendFile, mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Mission } from './contract.js';

async function atomicWrite(file: string, text: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
export class GuidedJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private constructor(readonly directory: string) {}
  static async create(outputDir: string, mission: Mission) {
    await mkdir(outputDir, { recursive: true });
    const directory = path.join(outputDir, `guided-${Date.now()}-${randomUUID()}`);
    await mkdir(directory);
    await atomicWrite(path.join(directory, 'mission.json'), JSON.stringify(mission, null, 2));
    await atomicWrite(path.join(directory, 'state.json'), JSON.stringify({ status: 'NOT_VERIFIED', closed: false }));
    const journal = new GuidedJournal(directory);
    await journal.append('started', { build: mission.buildReference, caseIds: mission.cases.map(c => c.id) });
    return journal;
  }
  append(type: string, data: unknown) {
    const event = JSON.stringify({ sequence: ++this.sequence, at: new Date().toISOString(), type, data });
    this.queue = this.queue.then(() =>
      appendFile(path.join(this.directory, 'events.jsonl'), `${event}\n`, { mode: 0o600, flush: true }),
    );
    return this.queue;
  }
  async saveReport(markdown: string, status: string, closed = false) {
    await this.queue;
    await atomicWrite(path.join(this.directory, 'report.md'), markdown);
    await atomicWrite(path.join(this.directory, 'state.json'), JSON.stringify({ status, closed }));
    return path.join(this.directory, 'report.md');
  }
}
/** Called once per output root by a new manager; never resumes browser actions. */
export async function recoverInterruptedReports(outputDir: string) {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries
    .filter(e => e.isDirectory() && e.name.startsWith('guided-'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 200)) {
    const directory = path.join(outputDir, entry.name);
    let state: { closed?: boolean; status?: string } = {};
    try {
      state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    } catch {
      /* Missing/corrupt state is interrupted, never completed. */
    }
    if (state?.closed === true) continue;
    const report = await readFile(path.join(directory, 'report.md'), 'utf8').catch(() => 'Overall: **NOT_VERIFIED**\n');
    const events = await readFile(path.join(directory, 'events.jsonl'), 'utf8').catch(() => '');
    const confirmedFailure = events.split('\n').some(line => {
      try {
        const e = JSON.parse(line);
        return (
          (e.type === 'check' && e.data?.stage === 'criterion' && e.data?.status === 'FAIL') ||
          (e.type === 'system_error' && e.data?.stage === 'after_action')
        );
      } catch {
        return false;
      }
    });
    const status =
      state?.status === 'FAIL' || /Overall: \*\*FAIL\*\*/.test(report) || confirmedFailure ? 'FAIL' : 'NOT_VERIFIED';
    await atomicWrite(
      path.join(directory, 'report.md'),
      report.replace(/Overall: \*\*\w+\*\*/, `Overall: **${status}**`) +
        '\nInterrupted: server restarted; no actions were resumed.\n',
    );
    await atomicWrite(path.join(directory, 'state.json'), JSON.stringify({ status, closed: true, interrupted: true }));
  }
}
