import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const { accessMock, readdirMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath } = vi.hoisted(() => {
  const accessMock = vi.fn();
  // Bin listing for the versioned SysTestConsole lookup; empty unless a test lists files.
  const readdirMock = vi.fn().mockResolvedValue([]);
  const readFileMock = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  // execFile needs a callback-style API for util.promisify
  const execFileMock: any = vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: '✅ Tests passed', stderr: '' });
  });
  const cfgEnsureLoaded = vi.fn();
  const cfgGetModelName = vi.fn().mockReturnValue('Contoso');
  const cfgGetPackagePath = vi.fn().mockReturnValue('K:\\AOSService\\PackagesLocalDirectory');
  return { accessMock, readdirMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath };
});

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('fs/promises', () => {
  const m = { access: accessMock, readFile: readFileMock, readdir: readdirMock };
  return { ...m, default: m };
});
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: cfgEnsureLoaded,
    getModelName: cfgGetModelName,
    getPackagePath: cfgGetPackagePath,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import path from 'path';
import { sysTestRunnerTool, compareSysTestDataAccess, findSysTestConsole } from '../../src/tools/sdlc/sysTestRunner';

const PKG = 'K:\\AOSService\\PackagesLocalDirectory';
const SYSTEST_CONSOLE = path.join(PKG, 'Bin', 'SysTestConsole.exe');
const SYSTEST_RUNNER = path.join(PKG, 'Bin', 'SysTestRunner.exe');
const SYSTEST_CONSOLE_17 = path.join(PKG, 'Bin', 'SysTestConsole.17.0.exe');

function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    if (paths.some(a => norm(a) === norm(p))) return;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
}

function capturedArgs(callIndex = 0): string[] {
  return execFileMock.mock.calls[callIndex]?.[1] ?? [];
}

describe('run_systest_class — binary resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅ Tests passed', stderr: '' });
    });
  });

  it('prefers SysTestConsole.exe when present', async () => {
    allowPaths([SYSTEST_CONSOLE]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    const [exe] = execFileMock.mock.calls[0];
    expect(exe).toBe(SYSTEST_CONSOLE);
  });

  it('uses /test: and /xml: flags for SysTestConsole.exe', async () => {
    allowPaths([SYSTEST_CONSOLE]);

    await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    const args = capturedArgs(0);
    expect(args).toContain('/test:ContosoMyTest');
    expect(args.some(a => a.startsWith('/xml:'))).toBe(true);
    // SysTestConsole has no -model:/-packagePath: flags (unlike the legacy fallback)
    expect(args.some(a => a.startsWith('-model:'))).toBe(false);
  });

  it('falls back to SysTestRunner.exe when SysTestConsole.exe is absent', async () => {
    allowPaths([SYSTEST_RUNNER]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest', testMethod: 'testFoo' }, {});

    expect(result.isError).toBeFalsy();
    const [exe] = execFileMock.mock.calls[0];
    expect(exe).toBe(SYSTEST_RUNNER);
    const args = capturedArgs(0);
    expect(args).toContain('-name:ContosoMyTest::testFoo');
    expect(args).toContain('-model:Contoso');
  });

  it('runs SysTestConsole.17.0.exe when that is the only SysTestConsole in Bin (#1143)', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe', 'SysTestConsole.17.0.exe.config', 'xppc.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock.mock.calls[0][0]).toBe(SYSTEST_CONSOLE_17);
    expect(capturedArgs(0)).toEqual(expect.arrayContaining(['/test:ContosoMyTest', '/unattended']));
  });

  it('prefers the versioned SysTestConsole over a plain one left by an older platform', async () => {
    // A 7.0.7858 dev VM: SysTestConsole.17.0.exe is 7.0.7858.111, like xppc.exe;
    // SysTestConsole.exe is 7.0.7452.66, from December 2024.
    readdirMock.mockResolvedValue(['SysTestConsole.exe', 'SysTestConsole.exe.config', 'SysTestConsole.17.0.exe', 'SysTestConsole.17.0.exe.config']);
    allowPaths([SYSTEST_CONSOLE, SYSTEST_CONSOLE_17]);

    await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(execFileMock.mock.calls[0][0]).toBe(SYSTEST_CONSOLE_17);
  });

  it('errors when neither binary is found', async () => {
    allowPaths([]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Neither SysTestConsole.exe nor SysTestRunner.exe found');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('errors when model name cannot be determined', async () => {
    cfgGetModelName.mockReturnValue(null);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot determine model name');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('notes that testMethod is ignored when running via SysTestConsole.exe', async () => {
    allowPaths([SYSTEST_CONSOLE]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest', testMethod: 'testFoo' }, {});

    expect(result.content[0].text).toContain('no per-method filter');
  });
});

describe('run_systest_class — interactive console blocker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('recognizes the WaitForDebugger/Console.ReadKey crash and explains it clearly', async () => {
    const err = Object.assign(new Error('Command failed'), {
      stdout: 'To debug, please attach VS debugger to SysTestConsole.exe now ...\nPress any key to continue..',
      stderr: 'Unhandled Exception: System.InvalidOperationException: Cannot read keys when either ' +
        'application does not have a console or when console input has been redirected from a file.\n' +
        '   at System.Console.ReadKey(Boolean intercept)\n' +
        '   at Microsoft.Dynamics.AX.Framework.SysTest.SysTestConsole.WaitForDebugger()',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    // The message no longer calls the runner interactive-only: /unattended is
    // passed and normally skips this prompt, so it now says what to do if the
    // prompt appears anyway.
    expect(result.content[0].text).toContain('debugger-attach prompt');
    expect(result.content[0].text).toContain('/unattended');
  });

  it('a plain test failure is NOT misclassified as the interactive-console blocker', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '❌ Tests FAILED\n\nContosoMyTest::testFoo failed: assertion error', stderr: '' });
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Tests FAILED');
    expect(result.content[0].text).not.toContain('debugger-attach prompt');
  });
});

describe('run_systest_class — the platform binding mismatch that stops a run', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('names the assembly and the config redirect instead of blaming the test', async () => {
    // Real output from this VM: the runner's own config redirects
    // Microsoft.ApplicationInsights to 2.22.0.997 while Bin ships 2.23.0.0, so the
    // telemetry logger throws before any test runs.
    const err = Object.assign(new Error('Command failed'), {
      stdout: 'Executing test(s) ....\n\nSystem.IO.FileLoadException: Could not load file or assembly ' +
        "'Microsoft.ApplicationInsights, Version=2.22.0.997, Culture=neutral, PublicKeyToken=31bf3856ad364e35' " +
        "or one of its dependencies. The located assembly's manifest definition does not match the assembly " +
        'reference. (Exception from HRESULT: 0x80131040)',
      stderr: '',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Microsoft.ApplicationInsights');
    expect(text).toContain('2.22.0.997');
    expect(text).toContain('SysTestConsole.exe.config');
    expect(text).toMatch(/No test ran/i);
    // It must not read as a test failure — nothing was executed.
    expect(text).not.toContain('Tests FAILED');
  });

  it('passes /unattended so the runner does not stop at the debugger prompt', async () => {
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation((_f: string, a: string[], _o: any, cb: Function) => {
      capturedArgs = a;
      cb(null, { stdout: 'ok', stderr: '' });
    });

    await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(capturedArgs).toContain('/unattended');
  });
});

describe('run_systest_class — a MISSING assembly is not the same fault as a wrong version', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('tells the caller to copy the file, not to edit a redirect', async () => {
    // Second fault seen on this VM once the redirect was fixed: the assembly the
    // (correct) redirect names is simply not in Bin.
    const err = Object.assign(new Error('Command failed'), {
      stdout: 'Executing test(s) ....\n\nSystem.IO.FileNotFoundException: Could not load file or assembly ' +
        "'System.ValueTuple, Version=4.0.3.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51' or one of " +
        'its dependencies. The system cannot find the file specified.',
      stderr: '',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('System.ValueTuple');
    expect(text).toContain('is not in PackagesLocalDirectory\\Bin at all');
    expect(text).toMatch(/Get-ChildItem/);
    // The redirect advice belongs to the other fault and must not appear here.
    expect(text).not.toMatch(/point the redirect at it/);
    expect(text).not.toContain('Tests FAILED');
  });
});

describe('findSysTestConsole', () => {
  const BIN = path.join(PKG, 'Bin');
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    allowPaths([]);
  });

  it('takes the highest version, compared as numbers', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.9.0.exe', 'SysTestConsole.17.10.exe', 'SysTestConsole.17.2.exe']);
    expect(await findSysTestConsole(BIN)).toBe(path.join(BIN, 'SysTestConsole.17.10.exe'));
  });

  it('ignores configs and look-alike names, case aside', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe.config', 'SysTestConsoleX.exe', 'SysTestConsole..exe', 'systestconsole.17.0.EXE']);
    expect(await findSysTestConsole(BIN)).toBe(path.join(BIN, 'systestconsole.17.0.EXE'));
  });

  it('falls back to SysTestConsole.exe, and to null, when no versioned one exists', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.exe']);
    allowPaths([path.join(BIN, 'SysTestConsole.exe')]);
    expect(await findSysTestConsole(BIN)).toBe(path.join(BIN, 'SysTestConsole.exe'));

    allowPaths([]);
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await findSysTestConsole(BIN)).toBeNull();
  });
});

describe('run_systest_class — reaching the database and failing to log in', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('blames neither the test nor the model, and points at the runner\'s own config', async () => {
    // Third fault on this VM, once both assembly problems were fixed by config.
    // It used to be reported as a "deployment credential", which sent the reader
    // hunting a rotated password. Nothing had rotated: SysTestConsole.exe.config
    // was the shipped template, naming a different database and a different user
    // with a placeholder password.
    const err = Object.assign(new Error('Command failed'), {
      stdout: "Executing test(s) ....\n\nSystem.Data.SqlClient.SqlException (0x80131904): Login failed for user 'AOSUser'.",
      stderr: '',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("could not log in as 'AOSUser'");
    expect(text).toMatch(/No test ran/);
    expect(text).toContain('SysTestConsole.exe.config');
    expect(text).toContain('web.config');
    expect(text).not.toContain('Tests FAILED');
  });

  it('compares and names the .config of the versioned SysTestConsole that ran', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.exe', 'SysTestConsole.17.0.exe']);
    allowPaths([SYSTEST_CONSOLE, SYSTEST_CONSOLE_17]);
    readFileMock.mockImplementation(async (file: string) => {
      const f = String(file).replace(/\\/g, '/').toLowerCase();
      if (f.endsWith('/bin/systestconsole.17.0.exe.config')) return '<configuration><appSettings><add key="DataAccess.Database" value="AxDbRain" /></appSettings></configuration>';
      if (f.endsWith('web.config')) return '<configuration><appSettings><add key="DataAccess.Database" value="AxDB" /></appSettings></configuration>';
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(Object.assign(new Error('Command failed'), { stdout: "Login failed for user 'AOSUser'.", stderr: '' }));
    });

    const text = (await sysTestRunnerTool({ className: 'ContosoMyTest' }, {})).content[0].text;

    expect(text).toContain('SysTestConsole.17.0.exe.config` disagrees');
    expect(text).toContain('DataAccess.Database');
  });
});

/**
 * The comparison behind that diagnosis. It reads two platform config files and
 * must never put the password in its answer — the value there is an encrypted
 * blob, and a diagnostic that quotes it would copy a secret into a transcript.
 */
describe('compareSysTestDataAccess', () => {
  const setting = (k: string, v: string) => `  <add key="${k}" value="${v}" />`;
  const doc = (rows: string[]) => [
    '<?xml version="1.0"?>',
    '<configuration>',
    '<appSettings>',
    ...rows,
    '</appSettings>',
    '</configuration>',
    '',
  ].join('\n');

  const RUNNER = doc([
    setting('DataAccess.Database', 'AxDbRain'),
    setting('DataAccess.SqlUser', 'AOSUser'),
    setting('DataAccess.SqlPwd', '$CREDENTIAL_PLACEHOLDER$'),
    setting('DataAccess.DbServer', '.'),
  ]);
  const AOS = doc([
    setting('DataAccess.Database', 'AxDB'),
    setting('DataAccess.SqlUser', 'axdbadmin'),
    setting('DataAccess.SqlPwd', 'x'.repeat(828)),
    setting('DataAccess.DbServer', 'D365DEVBOX-1'),
  ]);

  /** Serve the runner config, the AOS config, or ENOENT for anything else. */
  const serve = (runner?: string, aos?: string) => {
    readFileMock.mockImplementation(async (file: string) => {
      const f = String(file).replace(/\\/g, '/').toLowerCase();
      if (f.endsWith('systestconsole.exe.config') && runner !== undefined) return runner;
      if (f.endsWith('web.config') && aos !== undefined) return aos;
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    });
  };

  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
  });

  it('reports every setting the runner disagrees with the AOS about', async () => {
    serve(RUNNER, AOS);
    const drift = await compareSysTestDataAccess(PKG);
    expect(drift?.map(d => d.key)).toEqual([
      'DataAccess.Database', 'DataAccess.SqlUser', 'DataAccess.SqlPwd', 'DataAccess.DbServer',
    ]);
    expect(drift?.[0]).toMatchObject({ runner: '`AxDbRain`', aos: '`AxDB`' });
  });

  it('never puts the password in its answer', async () => {
    serve(RUNNER, AOS);
    const rendered = JSON.stringify(await compareSysTestDataAccess(PKG));
    expect(rendered).not.toContain('x'.repeat(828));
    // What a reader actually needs: that the runner's is the shipped placeholder,
    // and that the AOS has a real one — its length, not its bytes.
    expect(rendered).toContain('$CREDENTIAL_PLACEHOLDER$');
    expect(rendered).toContain('828 chars, not shown');
  });

  it('says nothing when the two agree', async () => {
    serve(AOS, AOS);
    expect(await compareSysTestDataAccess(PKG)).toEqual([]);
  });

  it('returns undefined — not an empty drift — when a file is missing', async () => {
    // An unreadable file is not evidence that the settings match; the caller
    // must fall back to generic advice instead of claiming they agree.
    serve(RUNNER, undefined);
    expect(await compareSysTestDataAccess(PKG)).toBeUndefined();
  });

  it('compares the live settings, not commented-out or reordered copies', async () => {
    // The runner config keeps the old database in a comment and writes the live
    // entry value-first: the regex reader saw only the comment, and so reported
    // a drift (AxDbRain vs AxDB) that the files do not have.
    serve(doc([
      '  <!-- <add key="DataAccess.Database" value="AxDbRain" /> -->',
      '  <add value="AxDB" key="DataAccess.Database" />',
      setting('DataAccess.SqlUser', 'axdbadmin'),
      setting('DataAccess.SqlPwd', 'x'.repeat(828)),
      setting('DataAccess.DbServer', 'D365DEVBOX-1'),
    ]), AOS);
    expect(await compareSysTestDataAccess(PKG)).toEqual([]);
  });

  it('ignores a key the AOS config does not carry', async () => {
    serve(RUNNER, doc([
      setting('DataAccess.Database', 'AxDbRain'),
      setting('DataAccess.SqlUser', 'AOSUser'),
      setting('DataAccess.SqlPwd', '$CREDENTIAL_PLACEHOLDER$'),
    ]));
    expect(await compareSysTestDataAccess(PKG)).toEqual([]);
  });
});
