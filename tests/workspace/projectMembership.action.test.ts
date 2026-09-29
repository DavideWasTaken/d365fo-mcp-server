import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The file lookup resolves against a model tree; point it at a temp one.
const found = new Map<string, string>();
vi.mock('../../src/utils/objectFileLookup.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/objectFileLookup.js')>()),
  findD365FileOnDisk: async (type: string, name: string) => found.get(`${type}:${name}`) ?? null,
}));

import { d365foFileTool } from '../../src/tools/d365foFile.js';
import { scaffoldProject } from '../../src/workspace/projectScaffold.js';
import { readProjectIncludes } from '../../src/workspace/projectMembership.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';
import { getConfigManager } from '../../src/utils/configManager.js';

const SLN = 'Microsoft Visual Studio Solution File, Format Version 12.00\r\nGlobal\r\nEndGlobal\r\n';

let root: string;
let a: string;
let b: string;

beforeEach(async () => {
  registerCustomModel('ContosoCore');
  found.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'membership-'));
  await fs.writeFile(path.join(root, 'ContosoCore.sln'), SLN);
  await fs.mkdir(path.join(root, 'T-000'));
  await fs.writeFile(path.join(root, 'T-000', 'T-000.rnrproj'), '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"/>');
  a = (await scaffoldProject({ projectName: 'T-001', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'shared' })).projectPath;
  b = (await scaffoldProject({ projectName: 'T-002', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'shared' })).projectPath;
  found.set('class:CtsoHelper', path.join(root, 'CtsoHelper.xml'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const call = (operation: string, params: Record<string, unknown>) =>
  d365foFileTool({
    method: 'tools/call',
    params: { name: 'd365fo_file', arguments: { action: 'project', params: { operation, modelName: 'ContosoCore', ...params } } },
  } as any, {} as any) as Promise<any>;

const has = async (project: string, include: string) => (await readProjectIncludes(project)).has(include.toLowerCase());

describe('d365fo_file(action="project") operations', () => {
  it('add-object registers an existing object; a second add reports it is already there', async () => {
    const r = await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('added');
    expect(await has(a, 'axclass\\ctsohelper')).toBe(true);
    expect((await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' })).content[0].text)
      .toContain('already in the project');
  });

  it('add-object refuses an object with no file on disk, and still handles the rest of the batch', async () => {
    const r = await call('add-object', {
      projectPath: a,
      objects: [{ objectType: 'class', objectName: 'Ghost' }, { objectType: 'class', objectName: 'CtsoHelper' }],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('no such file on disk');
    expect(await has(a, 'axclass\\ctsohelper')).toBe(true);
  });

  it('remove-object refuses the last reference unless allowOrphan is set', async () => {
    await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    const refused = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(refused.isError).toBe(true);
    expect(await has(a, 'axclass\\ctsohelper')).toBe(true);

    const ok = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper', allowOrphan: true });
    expect(ok.isError, ok.content[0].text).toBeFalsy();
    expect(await has(a, 'axclass\\ctsohelper')).toBe(false);
  });

  it('remove-object leaves the file alone and needs no override when another project lists it', async () => {
    await fs.writeFile(found.get('class:CtsoHelper')!, '<x/>');
    await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    await call('add-object', { projectPath: b, objectType: 'class', objectName: 'CtsoHelper' });
    const r = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(await has(a, 'axclass\\ctsohelper')).toBe(false);
    expect(await has(b, 'axclass\\ctsohelper')).toBe(true);
    await expect(fs.access(found.get('class:CtsoHelper')!)).resolves.toBeUndefined();
  });

  it('reports an object that is not in the project instead of failing', async () => {
    const r = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('not in the project');
  });

  it('refuses an explicit project that no solution lists', async () => {
    const stray = await fs.mkdtemp(path.join(os.tmpdir(), 'stray-'));
    try {
      const file = path.join(stray, 'Z.rnrproj');
      await fs.writeFile(file, '<Project/>');
      const r = await call('add-object', { projectPath: file, objectType: 'class', objectName: 'CtsoHelper' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('refusing');
    } finally { await fs.rm(stray, { recursive: true, force: true }); }
  });

  it('rejects an unknown objectType and an unknown operation', async () => {
    expect((await call('add-object', { projectPath: a, objectType: 'nope', objectName: 'X' })).isError).toBe(true);
    const r = await call('rename', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('create | delete | add-object | remove-object');
  });
});

describe('label files and the active project', () => {
  async function labelTree(langs: string[]) {
    const pkg = path.join(root, 'pkgs');
    const model = path.join(pkg, 'ContosoCore', 'ContosoCore');
    await fs.mkdir(path.join(pkg, 'ContosoCore', 'Descriptor'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'ContosoCore', 'Descriptor', 'ContosoCore.xml'),
      '<AxModelInfo><Name>ContosoCore</Name><ModelModule>ContosoCore</ModelModule></AxModelInfo>');
    await fs.mkdir(path.join(model, 'AxLabelFile'), { recursive: true });
    for (const l of langs) await fs.writeFile(path.join(model, 'AxLabelFile', `ContosoProj_${l}.xml`), '<x/>');
    return pkg;
  }

  it('add-object registers a label file with the languages found on disk', async () => {
    const pkg = await labelTree(['en-US', 'fi']);
    const r = await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    expect(r.isError, r.content[0].text).toBeFalsy();
    const xml = await fs.readFile(a, 'utf-8');
    for (const l of ['en-US', 'fi']) {
      expect(xml).toContain(`AxLabelFile\\ContosoProj_${l}`);
      expect(xml).toContain(`ContosoProj.${l}.label.txt`);
    }
    expect((await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg }))
      .content[0].text).toContain('already in the project');
  });

  it('reports a label file with no descriptors, and refuses removal', async () => {
    const pkg = await labelTree([]);
    const none = await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain('no label descriptor files');
    expect((await call('remove-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj' })).isError).toBe(true);
  });

  it('a project just created is the active one, so add-object needs no projectPath', async () => {
    const cfg = getConfigManager();
    try {
      const made = await call('create', { projectName: 'T-003', projectsRoot: root });
      expect(made.isError, made.content[0].text).toBeFalsy();
      await fs.writeFile(found.get('class:CtsoHelper')!, '<x/>');
      const r = await call('add-object', { objectType: 'class', objectName: 'CtsoHelper' });
      expect(r.isError, r.content[0].text).toBeFalsy();
      expect(await has(path.join(root, 'T-003', 'T-003.rnrproj'), 'axclass\\ctsohelper')).toBe(true);
    } finally {
      cfg.setRuntimeContext({ projectPath: undefined });
    }
  });

  it('without an active project the error says how to recover', async () => {
    getConfigManager().setRuntimeContext({ projectPath: undefined });
    const r = await call('add-object', { objectType: 'class', objectName: 'CtsoHelper' });
    if (r.isError) expect(r.content[0].text).toContain('pass projectPath');
  });
});
