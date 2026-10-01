/**
 * EXTENSION_CLASS_NAMING_STYLE="prefix-leading" — writer and validator agreement.
 *
 * The style writes `{Infix}{Base}_Extension`. Its first cut matched the infix
 * case-insensitively and without a word boundary, which produced three defects:
 *   - a "stale trailing infix" strip that cut the base's own last letters
 *     (prefix "Le": SalesTable → LeSalesTab_Extension);
 *   - a camelCase base (whsWorkExecute) whose written name could not be
 *     recognised as prefixed again, so every re-run grew another infix;
 *   - a validator that stripped "Con" off ContactPerson_Extension and reported
 *     base "tactPerson", recommending the unprefixed name back.
 * Writer and validator now share one derivation (prefixLeadingBaseOf), and every
 * case below checks both sides against each other.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeObjectName } from '../../src/utils/objectNaming.js';
import { applyObjectPrefix, registerCustomModel } from '../../src/utils/modelClassifier.js';
import { checkObjectNaming } from '../../src/utils/objectNamingRules.js';

const MODEL = 'ContosoExt';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => 'ContosoExt',
    getWriteAnchorModel: () => 'ContosoExt',
    getAutoDetectedModelName: async () => 'ContosoExt',
    getRawAutoDetectedModelName: () => 'ContosoExt',
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
  })),
}));

/** An empty symbol index: no conflicts, and base-object probes simply miss. */
const stmt = { all: () => [], get: () => undefined, run: () => {} };
const db: any = { prepare: () => stmt };

const ENV_KEYS = [
  'EXTENSION_PREFIX',
  'EXTENSION_SUFFIX',
  'EXTENSION_NAMING_STYLE',
  'EXTENSION_CLASS_NAMING_STYLE',
  'EXTENSION_PREFIX_SOURCE',
];
let saved: Record<string, string | undefined>;

function configure(prefix: string, classStyle = 'prefix-leading'): void {
  process.env.EXTENSION_PREFIX = prefix;
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  process.env.EXTENSION_CLASS_NAMING_STYLE = classStyle;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  registerCustomModel(MODEL);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const write = (name: string, type = 'class-extension') => normalizeObjectName(name, type, MODEL);
const check = (proposedName: string, baseObjectName?: string) =>
  checkObjectNaming(db, { proposedName, objectType: 'class-extension', baseObjectName, modelName: MODEL });
const namingWarnings = (warnings: string[]) =>
  warnings.filter(w => !w.startsWith('Base object'));

describe('prefix-leading: a trailing match that is not a word is not an infix', () => {
  it.each([
    ['Le', 'SalesTable', 'LeSalesTable_Extension'],
    ['Ne', 'SalesLine', 'NeSalesLine_Extension'],
    ['Al', 'LedgerJournal', 'AlLedgerJournal_Extension'],
  ])('prefix %s + %s → %s, from a bare base and from Base_Extension', (prefix, base, expected) => {
    configure(prefix);
    expect(write(base)).toBe(expected);
    expect(write(`${base}_Extension`, 'class')).toBe(expected);
    expect(write(expected)).toBe(expected);
  });

  it.each([
    ['Le', 'SalesTable'],
    ['Ne', 'SalesLine'],
  ])('the validator derives the whole base for prefix %s + %s and accepts what the writer wrote', async (prefix, base) => {
    configure(prefix);
    const written = write(base);
    const r = await check(written);
    expect(r.baseObjectName).toBe(base);
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });

  it('still converts a name written under the trailing "prefix" style', () => {
    configure('Ctso');
    expect(write('CustTableCtso_Extension', 'class')).toBe('CtsoCustTable_Extension');
    expect(write('CustTableCTSO_Extension', 'class')).toBe('CtsoCustTable_Extension');
  });
});

describe('prefix-leading: a camelCase base stays stable on re-run', () => {
  it('upper-cases the base\'s first letter so the infix ends at a word boundary', () => {
    configure('Ctso');
    const once = write('whsWorkExecute');
    expect(once).toBe('CtsoWhsWorkExecute_Extension');
    expect(write(once)).toBe(once);
    expect(write(write(once))).toBe(once);
  });

  it('the validator accepts the written name and names the base', async () => {
    configure('Ctso');
    const r = await check('CtsoWhsWorkExecute_Extension');
    expect(r.baseObjectName).toBe('WhsWorkExecute');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });

  it('…and agrees when the caller passes the camelCase base explicitly', async () => {
    configure('Ctso');
    const r = await check('CtsoWhsWorkExecute_Extension', 'whsWorkExecute');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });
});

describe('prefix-leading: the validator strips the infix only where the writer would', () => {
  it('ContactPerson_Extension under "Con" is base ContactPerson, missing its infix', async () => {
    configure('Con');
    const r = await check('ContactPerson_Extension');
    expect(r.baseObjectName).toBe('ContactPerson');
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('does not lead with the extension infix "Con"'))).toBe(true);
    expect(r.warnings.join('\n')).not.toContain('"tactPerson"');
    // The recommendation is exactly what the writer produces for the same name.
    expect(write('ContactPerson_Extension', 'class')).toBe('ConContactPerson_Extension');
    expect(r.warnings.join('\n')).toContain('Recommended: ConContactPerson_Extension');
  });

  it('an old trailing-style name gets the suggestion the writer would write', async () => {
    configure('Ctso');
    const r = await check('CustTableCtso_Extension');
    expect(r.baseObjectName).toBe('CustTable');
    const written = write('CustTableCtso_Extension', 'class');
    expect(written).toBe('CtsoCustTable_Extension');
    const all = [...r.warnings, ...r.suggestions].join('\n');
    expect(all).toContain(written);
    expect(all).not.toContain('CtsoCustTableCtso_Extension');
  });

  it('a correctly prefix-leading name passes clean', async () => {
    configure('Ctso');
    const r = await check('CtsoCustTable_Extension');
    expect(r.baseObjectName).toBe('CustTable');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });
});

describe('a base that itself starts with the infix as a word (ProjTable under "Proj")', () => {
  // Undecidable from the string alone: "ProjTable_Extension" is equally a base
  // ProjTable that needs the infix and a base Table that already has it.

  it('prefix-leading: a bare base states the base, so the infix is added', () => {
    configure('Proj');
    expect(write('ProjTable')).toBe('ProjProjTable_Extension');
    expect(write('ProjProjTable_Extension')).toBe('ProjProjTable_Extension');
  });

  it('prefix-leading: a caller-named ProjTable_Extension stays as given (reads as already prefixed)', () => {
    configure('Proj');
    expect(write('ProjTable_Extension', 'class')).toBe('ProjTable_Extension');
  });

  it('prefix-leading: a caller that knows the base gets the prefix through applyObjectPrefix too', () => {
    configure('Proj');
    expect(applyObjectPrefix('ProjTable_Extension', 'Proj', MODEL, { knownBase: true }))
      .toBe('ProjProjTable_Extension');
  });

  it('prefix-leading: the validator, told the base, recommends what the writer writes', async () => {
    configure('Proj');
    const r = await check('ProjTable_Extension', 'ProjTable');
    expect(r.warnings.some(w => w.includes('does not lead with the extension infix "Proj"'))).toBe(true);
    expect(r.warnings.join('\n')).toContain('Recommended: ProjProjTable_Extension');
    expect(write('ProjTable')).toBe('ProjProjTable_Extension');
  });

  it('"prefix" style: unchanged — pinned, not endorsed (the base is not told apart from the infix)', () => {
    // The trailing style reads a leading infix at a word boundary as "already
    // prefixed" (that is what keeps ConDemoRanges_Extension intact), and the
    // knownBase hint is deliberately ignored outside prefix-leading.
    configure('Proj', 'prefix');
    expect(write('ProjTable')).toBe('ProjTable_Extension');
    expect(write('ProjTable_Extension', 'class')).toBe('ProjTable_Extension');
    expect(applyObjectPrefix('ProjTable_Extension', 'Proj', MODEL, { knownBase: true }))
      .toBe('ProjTable_Extension');
  });
});

describe('the existing styles are untouched', () => {
  it('"prefix" keeps its trailing shape', () => {
    configure('Ctso', 'prefix');
    expect(write('CustTable')).toBe('CustTableCtso_Extension');
    expect(write('whsWorkExecute')).toBe('whsWorkExecuteCtso_Extension');
    expect(write('CustTableCtso_Extension', 'class')).toBe('CustTableCtso_Extension');
  });

  it('"model-name" keeps its shape', () => {
    configure('Ctso', 'model-name');
    expect(write('CustTable')).toBe('CustTable_ContosoExt_Extension');
  });
});
