import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLabelTool } from '../../src/tools/write/createLabel';
import type { XppServerContext } from '../../src/types/context';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getProjectPath: async () => null,
    getDevEnvironmentType: async () => 'traditional',
    getWriteAnchorModel: () => 'LocaleModel',
    getToolProjectSwitch: () => null,
  }),
}));

describe('create_label locale resolution', () => {
  let root: string;
  let resources: string;
  let bulkAddLabels: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'label-locales-'));
    resources = path.join(root, 'LocalePackage', 'LocaleModel', 'AxLabelFile', 'LabelResources');
    await fs.mkdir(resources, { recursive: true });
    bulkAddLabels = vi.fn();
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const file = (language: string) => path.join(resources, language, `LocaleModel.${language}.label.txt`);

  async function seed(language: string, content = '\uFEFFOther=Keep me\r\n') {
    await fs.mkdir(path.dirname(file(language)), { recursive: true });
    await fs.writeFile(file(language), content);
  }

  async function create(translations: Array<{ language: string; text: string; comment?: string }>, extra: Record<string, unknown> = {}) {
    const result = await createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Greeting', labelFileId: 'LocaleModel', model: 'LocaleModel',
        packageName: 'LocalePackage', packagePath: root, addToProject: false,
        translations, defaultComment: 'Default comment', ...extra,
      } },
    }, { symbolIndex: { bulkAddLabels } } as unknown as XppServerContext);
    expect(result.isError).toBeFalsy();
    return String(result.content[0].text);
  }

  it('matches exact locales case-insensitively before parent or English translations', async () => {
    await seed('it-it');
    const reply = await create([
      { language: 'en-US', text: 'Hello' },
      { language: 'it', text: 'Ciao' },
      { language: 'IT-IT', text: 'Buongiorno', comment: 'Exact comment' },
    ], { languages: ['it-IT'] });
    expect(await fs.readFile(file('it-it'), 'utf8')).toContain('Greeting=Buongiorno\r\n ;Exact comment');
    expect(reply).toContain('it-it  → Buongiorno');
    expect(reply).not.toMatch(/fallback/i);
    expect(await fs.readdir(resources)).toEqual(['it-it']);
  });

  it('writes supplied Italian to both it and it-IT and discloses the parent source', async () => {
    await seed('it');
    await seed('it-IT');
    const reply = await create([
      { language: 'en-US', text: 'Hello' },
      { language: 'it', text: 'Ciao', comment: 'Italian comment' },
    ]);
    for (const locale of ['it', 'it-IT']) {
      expect(await fs.readFile(file(locale), 'utf8')).toContain('Greeting=Ciao\r\n ;Italian comment');
    }
    expect(reply).toContain('it-IT  → Ciao');
    expect(reply).toMatch(/⚠.*fallback.*it → it-IT/i);
    expect(bulkAddLabels.mock.calls[0][0]).toContainEqual(expect.objectContaining({
      language: 'it-IT', text: 'Ciao', comment: 'Italian comment',
    }));
    expect(bulkAddLabels.mock.calls[0][1]).toEqual({ skipFtsRebuild: true, keepTriggers: true });
  });

  it('chooses the nearest supplied parent in a locale chain', async () => {
    await seed('zh-Hant-TW');
    const reply = await create([
      { language: 'en-US', text: 'English' },
      { language: 'zh', text: 'Base Chinese' },
      { language: 'ZH-Hant', text: 'Traditional Chinese' },
    ], { languages: ['zh-Hant-TW'] });
    expect(await fs.readFile(file('zh-Hant-TW'), 'utf8')).toContain('Greeting=Traditional Chinese');
    expect(reply).toMatch(/⚠.*fallback.*ZH-Hant → zh-Hant-TW/i);
  });

  it('does not choose a sibling locale and warns when using case-insensitive en-US fallback', async () => {
    await seed('it-IT');
    const reply = await create([
      { language: 'it-CH', text: 'Swiss Italian', comment: 'Swiss comment' },
      { language: 'EN-us', text: 'Hello', comment: 'English comment' },
    ], { languages: ['it-IT'] });
    const content = await fs.readFile(file('it-IT'), 'utf8');
    expect(content).toContain('Greeting=Hello\r\n ;Default comment');
    expect(reply).toContain('it-IT  → Hello');
    expect(reply).toMatch(/⚠.*fallback.*EN-us → it-IT/i);
  });

  it('reports the first supplied locale as the last-resort source when English is absent', async () => {
    await seed('de-DE');
    const reply = await create([{ language: 'it', text: 'Ciao' }], { languages: ['de-DE'] });
    expect(await fs.readFile(file('de-DE'), 'utf8')).toContain('Greeting=Ciao');
    expect(reply).toMatch(/⚠.*fallback.*it → de-DE/i);
    expect(reply).not.toContain('en-US');
  });

  it('leaves skipped existing text untouched and omits fallback claims for that locale', async () => {
    const original = '\uFEFFGreeting=Esistente\r\n ;Keep comment\r\n';
    await seed('it-IT', original);
    const reply = await create([{ language: 'it', text: 'Nuovo' }], { languages: ['it-IT'], createIfMissing: true });
    expect(await fs.readFile(file('it-IT'), 'utf8')).toBe(original);
    expect(reply).toContain('Esistente');
    expect(reply).not.toMatch(/fallback/i);
    expect(bulkAddLabels).not.toHaveBeenCalled();
  });

  it('uses the resolved parent when explicitly updating an existing label', async () => {
    await seed('it-IT', '\uFEFFGreeting=Old English\r\n ;Old comment\r\nOther=Keep me\r\n');
    const reply = await create([
      { language: 'en-US', text: 'New English' },
      { language: 'it', text: 'Nuovo' },
    ], { languages: ['it-IT'], overwriteExisting: true });
    const content = await fs.readFile(file('it-IT'), 'utf8');
    expect(content).toContain('Greeting=Nuovo');
    expect(content).toContain('Other=Keep me');
    expect(content).not.toContain('Old English');
    expect(reply).toContain('it-IT  → Nuovo');
  });
});
