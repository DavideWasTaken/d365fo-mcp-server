import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GuidedJournal, recoverInterruptedReports } from '../../src/tools/sdlc/uiVerification/guided/journal.js';
import { exampleMission } from '../../src/tools/sdlc/uiVerification/guided/contract.js';
let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('marks a corrupt crash state interrupted, preserves functional FAIL and never resumes actions', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'guided-journal-'));
  const first = await GuidedJournal.create(directory, exampleMission);
  await first.saveReport('Overall: **PASS**\n', 'PASS');
  await writeFile(path.join(first.directory, 'state.json'), '{partial');
  const second = await GuidedJournal.create(directory, exampleMission);
  await second.append('check', { stage: 'criterion', status: 'FAIL' });
  await second.saveReport('Overall: **NOT_VERIFIED**\n', 'NOT_VERIFIED');
  const third = await GuidedJournal.create(directory, exampleMission);
  await third.saveReport('Overall: **PASS**\n', 'PASS', true);
  await recoverInterruptedReports(directory);
  expect(await readFile(path.join(first.directory, 'report.md'), 'utf8')).toContain('Overall: **NOT_VERIFIED**');
  expect(await readFile(path.join(second.directory, 'report.md'), 'utf8')).toContain('Overall: **FAIL**');
  expect(await readFile(path.join(third.directory, 'report.md'), 'utf8')).not.toContain('Interrupted');
});
