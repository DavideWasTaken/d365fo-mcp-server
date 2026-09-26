import { open } from 'node:fs/promises';
import { PlanSchema } from './contract.js';

/** Read bounded local JSON without loading an arbitrarily large file into memory. */
export async function readPlan(planPath: string) {
  const limit = 2 * 1024 * 1024;
  const file = await open(planPath, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('Saved UI plan exceeds 2 MiB');
    return PlanSchema.parse(JSON.parse(buffer.toString('utf8', 0, length)));
  } finally {
    await file.close();
  }
}
