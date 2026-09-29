/**
 * `doctor` on a traditional VM with no cross-reference database configured.
 *
 * Only UDE's XPP config names DYNAMICSXREFDB. On a traditional VM nothing else
 * did, so the bridge started without cross-references and find_references
 * answered from a name-based search — silently, which is what made it look like
 * the xref simply had no metadata references.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkXrefConfigured } from '../../src/cli/commands/doctor.js';
import { openStore, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';

describe('doctor — cross-reference database', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'doctor-xref-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('names the setting to configure when no database is set', () => {
    const result = checkXrefConfigured(openStore(dir, null));
    expect(result?.severity).toBe('info');
    expect(result?.message).toContain('name-based search');
    expect(result?.fix).toContain('bridge.xrefDbName');
    expect(result?.fix).toContain('DYNAMICSXREFDB');
  });

  it('is quiet once the database name is configured', () => {
    const store = openStore(dir, null);
    writeSetting(store, settingByPath('bridge.xrefDbName')!, 'DYNAMICSXREFDB');
    expect(checkXrefConfigured(store)).toBeNull();
  });
});
