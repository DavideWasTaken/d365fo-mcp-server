import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import { CustomHttpTransport } from '../../src/server/transport.js';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyUiCustomizationTool } from '../../src/tools/sdlc/verifyUiCustomization.js';
import { GuidedSessionManager } from '../../src/tools/sdlc/uiVerification/guided/sessionManager.js';
import { exampleMission } from '../../src/tools/sdlc/uiVerification/guided/contract.js';
import { currentUiRequest } from '../../src/server/uiRequestContext.js';

let listener: HttpServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>(r => listener!.close(() => r()));
  }
});
it('preserves UI JSON and image blocks through the actual HTTP transport without logging the capability', async () => {
  const logs: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
    logs.push(String(s));
    return true;
  }) as any);
  const app = express();
  app.use(express.json());
  const secret = 'private-session-capability';
  const server = {
    connect: async (transport: any) => {
      transport.onmessage = async (request: any) =>
        transport.send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ sessionId: secret, phase: 'DISCOVERING' }) },
              { type: 'image', mimeType: 'image/png', data: 'fixture' },
            ],
          },
        });
    },
  };
  new CustomHttpTransport(server as any, app, {} as any);
  listener = await new Promise<HttpServer>(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const port = (listener.address() as any).port;
  const result: any = await (
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'verify_ui_customization', arguments: { action: 'start' } },
      }),
    })
  ).json();
  expect(JSON.parse(result.result.content[0].text).sessionId).toBe(secret);
  expect(result.result.content[1].type).toBe('image');
  expect(logs.join('')).not.toContain(secret);
});

it('drives a real browser over independent HTTP POSTs, rejects foreign origins and deduplicates writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'guided-http-'));
  const application = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<button aria-label="Company">USMF</button><button onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output role="status">Pending</output>',
    );
  });
  await new Promise<void>(r => application.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(application.address() as any).port}`;
  const profilePath = path.join(directory, 'profile.json');
  await writeFile(profilePath, JSON.stringify({ baseUrl, storageState: 'auth.json', outputDir: 'reports' }));
  const manager = new GuidedSessionManager({ headless: true });
  const app = express();
  app.use(express.json());
  const signals: AbortSignal[] = [];
  const server = {
    connect: async (transport: any) => {
      transport.onmessage = async (request: any) => {
        signals.push(currentUiRequest()!.signal);
        const result = await verifyUiCustomizationTool(request.params.arguments, {
          guidedManager: manager,
          transport: 'http',
        });
        await transport.send({ jsonrpc: '2.0', id: request.id, result });
      };
    },
  };
  new CustomHttpTransport(server as any, app, {} as any);
  listener = await new Promise<HttpServer>(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const url = `http://127.0.0.1:${(listener.address() as any).port}/mcp`;
  const post = async (args: any, origin?: string) => {
    const response: any = await (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'verify_ui_customization', arguments: args },
        }),
      })
    ).json();
    return response.result;
  };
  const parsed = async (args: any) => JSON.parse((await post(args)).content[0].text);
  try {
    const mission = structuredClone(exampleMission);
    mission.startUrl = '/';
    mission.cases = [
      {
        id: 'save',
        goal: 'Save through UI',
        preconditions: [{ id: 'ready', targetDescription: 'Save button', check: 'enabled', expected: true }],
        criteria: [
          { id: 'saved', targetDescription: 'Result status', check: 'text', expected: 'Saved', match: 'exact' },
        ],
      },
    ];
    const start = await parsed({ action: 'start', mission, profilePath });
    expect(start.sessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(start.browserChannel).toBe('chromium');
    expect(signals[0].aborted).toBe(false);
    const sessionId = start.sessionId,
      base = { sessionId, caseId: 'save' };
    expect((await post({ action: 'observe', sessionId }, 'https://untrusted.example')).isError).toBe(true);
    const prepared = await parsed({ action: 'case', operation: 'prepare', ...base });
    const snapshotId = prepared.observation.snapshotId;
    const companyRef = prepared.observation.nodes.find((n: any) => n.name === 'Company').ref;
    const saveRef = prepared.observation.nodes.find((n: any) => n.name === 'Save').ref;
    expect((await parsed({ action: 'case', operation: 'begin', ...base, snapshotId, companyRef })).phase).toBe(
      'PRECONDITIONS',
    );
    expect(
      (
        await parsed({
          action: 'check',
          ...base,
          stage: 'precondition',
          criterionId: 'ready',
          snapshotId,
          ref: saveRef,
        })
      ).check.status,
    ).toBe('PASS');
    const action = {
      action: 'act',
      ...base,
      snapshotId,
      operationId: 'save-once',
      actions: [{ type: 'click', ref: saveRef }],
    };
    const acted = await parsed(action);
    expect(acted.completed).toBe(1);
    expect((await parsed(action)).historical).toBe(true);
    const statusRef = acted.observation.nodes.find((n: any) => n.role === 'status').ref;
    expect(
      (
        await parsed({
          action: 'check',
          ...base,
          criterionId: 'saved',
          snapshotId: acted.observation.snapshotId,
          ref: statusRef,
        })
      ).check.status,
    ).toBe('PASS');
    const finished = await parsed({ action: 'finish', sessionId });
    expect(finished.status).toBe('PASS');
    expect(await readFile(finished.reportPath, 'utf8')).toContain('Saved');
    expect(await readFile(finished.reportPath, 'utf8')).toContain('Browser: chromium');
    expect(signals.every(s => !s.aborted)).toBe(true);
  } finally {
    await manager.dispose();
    await new Promise<void>(r => application.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
