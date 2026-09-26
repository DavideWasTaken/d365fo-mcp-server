import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { inspectSystemErrors } from '../../src/tools/sdlc/uiVerification/systemErrors.js';

describe('system error inspection stability', () => {
  for (const event of ['frameattached', 'framedetached', 'framenavigated']) {
    it(`does not report clean if ${event} occurs after an earlier frame was read`, async () => {
      const page = new EventEmitter();
      const earlier = {
        url: () => 'http://fixture.test/',
        parentFrame: () => null,
        evaluate: async () => ({ complete: true, codes: [] }),
      };
      const later = {
        ...earlier,
        evaluate: async () => {
          page.emit(event, earlier);
          return { complete: true, codes: [] };
        },
      };
      Object.assign(page, { mainFrame: () => earlier, frames: () => [earlier, later] });
      expect((await inspectSystemErrors(page as unknown as Page, 'http://fixture.test')).complete).toBe(false);
      expect(page.eventNames()).toEqual([]);
    });
  }
});
