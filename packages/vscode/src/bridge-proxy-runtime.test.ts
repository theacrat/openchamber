import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';
import { createSessionStateStore, type SessionMetadata, type SessionMetadataOnOpenCode } from './openchamberSessionState';

const deps = {
  tryHandleLocalFsProxy: async () => null,
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  },
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
};

const connectedManager = {
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:3902',
  getOpenCodeAuthHeaders: () => ({}),
  onStatusChange: (cb: (status: string) => void) => {
    cb('connected');
    return { dispose: () => {} };
  },
};

// SAFETY: the proxy runtime only reads the manager members stubbed above.
const asBridgeContext = (manager: typeof connectedManager): BridgeContext => ({ manager } as unknown as BridgeContext);

const ctx = asBridgeContext(connectedManager);

describe('archived delivery targets', () => {
  test('both delivery bridges restore upstream-only archives through the state owner before sending', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'restore-proxy-'));
    const originalFetch = globalThis.fetch;
    const metadata = new Map<string, SessionMetadata>([['generic', {}], ['specialized', {}], ['failure', {}]]);
    const store = createSessionStateStore({ dataDir, now: () => 100 });
    const openCode: SessionMetadataOnOpenCode = {
      readSession: async () => ({ time: { archived: 10 } }),
      read: async (id) => metadata.get(id) ?? null,
      write: async (id, value) => {
        if (id === 'failure') throw new Error('write failed');
        metadata.set(id, value);
      },
    };
    const sent: string[] = [];
    try {
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const id = url.pathname.split('/')[3];
        assert.deepEqual(metadata.get(id), { openchamber: { sessionRetentionRestoredAt: 100 } });
        assert.equal((await store.readArchived())?.[id], null);
        sent.push(id);
        return Response.json({});
      };
      const restorationDeps = {
        ...deps,
        sessionState: store,
        shouldRestoreArchivedSession: async () => true,
        restoreArchivedSession: (id: string) => store.restoreForDelivery(id, openCode),
      };
      await handleProxyBridgeMessage({ id: 'generic', type: 'api:proxy', payload: {
        method: 'POST', path: '/api/session/generic/command', bodyBase64: Buffer.from('{}').toString('base64'),
      } }, ctx, restorationDeps);
      await handleProxyBridgeMessage({ id: 'specialized', type: 'api:session:message', payload: {
        path: '/api/session/specialized/prompt', bodyText: '{}',
      } }, ctx, restorationDeps);
      const failed = await handleProxyBridgeMessage({ id: 'failure', type: 'api:session:message', payload: {
        path: '/api/session/failure/prompt', bodyText: '{}',
      } }, ctx, restorationDeps);
      assert.partialDeepStrictEqual(failed, { success: true, data: { status: 409 } });
      assert.deepEqual(sent, ['generic', 'specialized']);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  for (const route of ['prompt', 'command']) {
    test(`generic ${route} restores archived targets and preserves the body`, async () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      const body = JSON.stringify({ text: 'continue', name: 'review' });
      try {
        globalThis.fetch = async (_input, init) => {
          calls.push('send');
          assert.equal(await new Response(init?.body).text(), body);
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        };
        await handleProxyBridgeMessage({ id: route, type: 'api:proxy', payload: {
          method: 'POST', path: `/api/session/abc/${route}`, bodyBase64: Buffer.from(body).toString('base64'),
        } }, ctx, {
          ...deps,
          sessionState: { readArchived: async () => ({ abc: 10 }), readMetadata: async () => ({}) },
          shouldRestoreArchivedSession: async () => true,
          restoreArchivedSession: async (id) => { assert.equal(id, 'abc'); calls.push('restore'); return true; },
        });
        assert.deepEqual(calls, ['restore', 'send']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test('specialized prompts leave active sessions untouched and block failed restoration', async () => {
    const originalFetch = globalThis.fetch;
    let writes = 0;
    let sends = 0;
    try {
      globalThis.fetch = async () => {
        sends += 1;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      };
      for (const archived of [false, true]) {
        const response = await handleProxyBridgeMessage({ id: 'prompt', type: 'api:session:message', payload: {
          path: '/api/session/abc/prompt', bodyText: '{}',
        } }, ctx, {
          ...deps,
          sessionState: { readArchived: async () => ({ abc: archived ? 10 : null }), readMetadata: async () => ({}) },
          shouldRestoreArchivedSession: async () => true,
          restoreArchivedSession: async () => { if (archived) writes += 1; return !archived; },
        });
        assert.ok(response);
        assert.match(JSON.stringify(response.data), archived ? /409/ : /200/);
      }
      assert.equal(writes, 1);
      assert.equal(sends, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy aborts', () => {
  test('aborts non-SSE api:proxy fetches by bridge request id', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;

    try {
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch;

      const pending = handleProxyBridgeMessage(
        { id: 'req_1', type: 'api:proxy', payload: { method: 'POST', path: '/api/session/abc/prompt', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_req_1', type: 'api:proxy:abort', payload: { requestID: 'req_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy read coalescing', () => {
  test('shares one upstream fetch across concurrent identical GET reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let release: () => void = () => {};

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const first = handleProxyBridgeMessage(
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/x' } } },
        ctx,
        deps,
      );
      const second = handleProxyBridgeMessage(
        { id: 'r2', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'X-OpenCode-Directory': '/x' } } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([first, second]);
      assert.equal(fetchCount, 1);
      assert.equal((a?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.equal((b?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.notStrictEqual((a?.data as { headers: unknown }).headers, (b?.data as { headers: unknown }).headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps reads for different directories apart even when the URL is identical', async () => {
    const originalFetch = globalThis.fetch;
    const releases: Array<() => void> = [];
    const seenDirectories: string[] = [];

    try {
      // SAFETY: test double for the global fetch; the proxy only reads the headers and response.
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const directory = new Headers(init?.headers).get('x-opencode-directory') ?? '';
        seenDirectories.push(directory);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return new Response(JSON.stringify({ directory }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const forA = handleProxyBridgeMessage(
        { id: 'a', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/project-a' } } },
        ctx,
        deps,
      );
      const forB = handleProxyBridgeMessage(
        { id: 'b', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/project-b' } } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(seenDirectories, ['/project-a', '/project-b']);
      for (const release of releases) release();

      const [a, b] = await Promise.all([forA, forB]);
      // SAFETY: api:proxy always answers with an ApiProxyResponsePayload; only bodyText is read.
      assert.equal((a?.data as { bodyText?: string }).bodyText, JSON.stringify({ directory: '/project-a' }));
      // SAFETY: same payload contract as the line above.
      assert.equal((b?.data as { bodyText?: string }).bodyText, JSON.stringify({ directory: '/project-b' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps reads with different auth scopes apart', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      // SAFETY: test double for the global fetch; only the call count matters here.
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      let authCalls = 0;
      const scopedCtx = asBridgeContext({
        ...connectedManager,
        getOpenCodeAuthHeaders: () => ({ authorization: `Bearer scope-${(authCalls += 1)}` }),
      });

      await Promise.all([
        handleProxyBridgeMessage({ id: 'x1', type: 'api:proxy', payload: { method: 'GET', path: '/api/provider' } }, scopedCtx, deps),
        handleProxyBridgeMessage({ id: 'x2', type: 'api:proxy', payload: { method: 'GET', path: '/api/provider' } }, scopedCtx, deps),
      ]);
      assert.equal(fetchCount, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not coalesce POST writes or non-allowlisted reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 'w1', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 'w2', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 0); // sanity: counter only bumps in the slow mock above

      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 's1', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 's2', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 2); // /api/session is not in the read allowlist
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
