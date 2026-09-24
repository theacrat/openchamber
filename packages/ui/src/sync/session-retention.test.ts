import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import * as sessionRoutes from './session-archive-batch';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from './session-ui-store';
import { replaceGlobalSessionStatusById } from './global-session-status';
import { buildSessionRetentionCandidates, runAutomaticSessionRetention, useSessionRetentionRunStore } from './session-retention';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import { resetGlobalBlockingRequests } from './global-blocking-requests';
import type { GitHubPullRequestStatus, GitStatus } from '@/lib/api/types';
import { getPersistedSessionRestoredAt, getSessionRestoredAt, markSessionRestored } from './session-retention-state';

const now = Date.now();
const day = 86_400_000;
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, projectID: 'project', directory: '/retention-project', title: id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now - 60 * day, updated: now - 40 * day }, ...patch,
});
const recent = Array.from({ length: 5 }, (_, index) => session(`recent-${index}`, {
  time: { created: now - day, updated: now - day },
}));
const archived = (id: string, patch: Partial<Session> = {}): Session => session(id, {
  time: { created: now - 60 * day, updated: now - 40 * day, archived: now - 40 * day }, ...patch,
});
const recentArchived = recent.map((item) => ({ ...item, id: `archived-${item.id}`, time: { ...item.time, archived: now - day } }));
const candidates = (sessions: Session[], action: 'archive' | 'delete' = 'delete') => buildSessionRetentionCandidates({
  sessions: [...recent, ...sessions], cutoffDays: 30, currentSessionId: null, action, activeSessionIds: new Set(), now,
});
const seed = (sessions: Session[]) => useGlobalSessionsStore.getState().applySnapshot(
  [...recent, ...sessions.filter((item) => !item.time.archived)],
  sessions.filter((item) => item.time.archived),
);

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://retention.test', runtimeKey: 'retention-test' });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionRetentionRunStore.setState({ isRunning: false });
  useSessionUIStore.setState({ currentSessionId: null, isLoading: false });
  replaceGlobalSessionStatusById(new Map());
  useUIStore.setState({ autoDeleteLastRunAt: 0 });
  useUIStore.setState({ sessionAutoArchiveEnabled: false, sessionAutoArchiveAfterDays: 30,
    sessionAutoArchiveOnMerge: false, sessionAutoDeleteArchivedEnabled: false,
    sessionAutoDeleteArchivedAfterDays: 30, sessionRetentionExcludePinned: true });
  useSessionPinnedStore.getState().setIds(new Set());
  resetGlobalBlockingRequests();
  useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
  spyOn(useMessageQueueStore.getState(), 'hydrate').mockResolvedValue();
  spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(async () => {
    const state = useGlobalSessionsStore.getState();
    return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
  });
  spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
    const item = useGlobalSessionsStore.getState().entityById.get(id);
    if (!item) throw Object.assign(new Error('not found'), { status: 404 });
    return item;
  });
  spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { mock.restore(); });

describe('retention eligibility', () => {
  test('retains recent, current, archived and running sessions', () => {
    const sessions = [
      session('old'), session('current'),
      session('archived', { time: { created: 1, updated: 2, archived: 3 } }), session('busy'),
    ];
    expect(buildSessionRetentionCandidates({
      sessions: [...recent, ...sessions], cutoffDays: 30, currentSessionId: 'current', action: 'delete',
      activeSessionIds: new Set(['busy']), now,
    })).toEqual(['old']);
  });

  test('protects every ancestor of a recent or archived child from cascade deletion', () => {
    for (const child of [recent[0],
      session('archived', { time: { created: 1, updated: 2, archived: 3 } })]) {
      expect(candidates([
        session('root'), session('middle', { parentID: 'root' }), { ...child, parentID: 'middle' }, session('unrelated'),
      ])).toEqual(['unrelated']);
    }
  });

  test('archives old parents independently because archiving does not cascade', () => {
    expect(candidates([session('root'), { ...recent[0], parentID: 'root' }], 'archive')).toEqual(['root']);
  });

  test('retains parents with an attached side conversation for either action', () => {
    const parent = session('parent', { metadata: { openchamber: { btwSessionID: 'side' } } });
    expect(candidates([parent])).toEqual([]);
    expect(candidates([parent], 'archive')).toEqual([]);
  });

  test('orders descendants before ancestors regardless of timestamps or list order', () => {
    expect(candidates([session('root'), session('child', { parentID: 'root' }), session('leaf', { parentID: 'child' })]))
      .toEqual(['leaf', 'child', 'root']);
  });

  test('never selects a record that carries no timestamps', () => {
    // Models a cached record another build wrote without `time`; the filter
    // must protect it rather than throw on the first render.
    const stale = Object.assign(session('stale'), { time: undefined });
    expect(candidates([stale, session('old')])).toEqual(['old']);
    expect(candidates([stale, session('old')], 'archive')).toEqual(['old']);
  });

  test('rejects invalid retention periods and cycles', () => {
    for (const cutoffDays of [0, -1, NaN, Infinity]) {
      expect(buildSessionRetentionCandidates({
        sessions: [session('old')], cutoffDays, currentSessionId: null, action: 'delete', activeSessionIds: new Set(), now,
      })).toEqual([]);
    }
    expect(candidates([session('a', { parentID: 'b' }), session('b', { parentID: 'a' })])).toEqual([]);
  });
});

describe('retention execution', () => {
  const mergeAPIs = (mergedAt = now - 2 * day) => {
    const git = { getGitStatus: async (): Promise<GitStatus> => ({
      current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
    }) };
    const github = { prStatus: async (): Promise<GitHubPullRequestStatus> => ({
      connected: true, pr: { number: 1, title: 'Feature', url: 'https://github.com/example/repo/pull/1',
        state: 'merged', draft: false, base: 'main', head: 'feature', mergedAt: new Date(mergedAt).toISOString() },
    }) };
    return { git: { getGitStatus: spyOn(git, 'getGitStatus') }, github: { prStatus: spyOn(github, 'prStatus') } };
  };
  const archiveSuccess = () => spyOn(sessionRoutes, 'requestSessionArchiveBatch').mockImplementation(async (_directory, ids) => ({
    outcome: 'archived', archived: ids.map((id) => ({ id, archivedAt: now })), failedIds: [],
  }));

  test('archives a branch merge without explicit links and discovers each directory once', async () => {
    seed([session('branch-a'), session('branch-b')]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    archiveSuccess();
    const apis = mergeAPIs();
    expect((await runAutomaticSessionRetention(apis)).archivedIds).toEqual(['branch-a', 'branch-b']);
    expect(apis.git.getGitStatus.mock.calls).toHaveLength(1);
    expect(apis.github.prStatus.mock.calls).toEqual([['/retention-project', 'feature']]);
  });

  test('keeps post-merge activity and invalid or missing merge timestamps', async () => {
    seed([session('before'), session('after', { time: { created: 1, updated: now - day } })]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    archiveSuccess();
    expect((await runAutomaticSessionRetention(mergeAPIs())).archivedIds).toEqual(['before']);
    for (const mergedAt of [null, 'invalid']) {
      const apis = mergeAPIs();
      apis.github.prStatus.mockResolvedValue({ connected: true, pr: {
        number: 1, title: '', url: '', state: 'merged', draft: false, base: 'main', head: 'feature', mergedAt,
      } });
      expect((await runAutomaticSessionRetention(apis)).archivedIds).toEqual([]);
    }
  });

  test('a restored PR1 stays active but a later PR2 merge can archive the same branch', async () => {
    const restored = session('restored-branch', { metadata: { openchamber: { sessionRetentionRestoredAt: now - 3 * day } } });
    seed([restored]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    archiveSuccess();
    expect((await runAutomaticSessionRetention(mergeAPIs(now - 4 * day))).archivedIds).toEqual([]);
    const apis = mergeAPIs();
    const next = await apis.github.prStatus();
    if (!next.pr) throw new Error('expected PR');
    apis.github.prStatus.mockResolvedValue({ ...next, pr: { ...next.pr, number: 2 } });
    expect((await runAutomaticSessionRetention(apis)).archivedIds).toEqual(['restored-branch']);
  });

  test('rechecks settings after the final awaited activity read', async () => {
    seed([session('disabled-last')]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    const archive = archiveSuccess();
    let reads = 0;
    spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async () => {
      if (++reads > 1) useUIStore.setState({ sessionAutoArchiveOnMerge: false });
      return {};
    });
    expect((await runAutomaticSessionRetention(mergeAPIs())).archivedIds).toEqual([]);
    expect(archive.mock.calls).toHaveLength(0);
  });

  test('settings disabled during action cleanup prevent archive and delete requests', async () => {
    for (const deleting of [false, true]) {
      const target = deleting ? archived('disable-in-delete') : session('disable-in-archive');
      seed(deleting ? [...recentArchived, target] : [target]);
      useUIStore.setState({ sessionAutoArchiveOnMerge: !deleting, sessionAutoDeleteArchivedEnabled: deleting });
      const archive = archiveSuccess();
      const remove = spyOn(opencodeClient, 'deleteSession').mockResolvedValue(true);
      let reads = 0;
      spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
        const record = useGlobalSessionsStore.getState().entityById.get(id);
        if (!record) throw new Error('missing session');
        if (id === target.id && ++reads === 2) {
          await Promise.resolve();
          useUIStore.setState({ sessionAutoArchiveOnMerge: false, sessionAutoDeleteArchivedEnabled: false });
        }
        return record;
      });
      const result = await runAutomaticSessionRetention(mergeAPIs());
      expect(reads).toBe(2);
      expect(result).toEqual({ archivedIds: [], deletedIds: [], failedIds: [] });
      expect(archive.mock.calls).toHaveLength(0);
      expect(remove.mock.calls).toHaveLength(0);
      expect(useGlobalSessionsStore.getState().entityById.has(target.id)).toBe(true);
    }
  });

  test('delivery beginning during action cleanup vetoes the archive request', async () => {
    const targetSession = session('delivery-in-cleanup');
    seed([targetSession]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    const archive = archiveSuccess();
    const target = createMessageQueueTarget(targetSession.id, targetSession.directory);
    if (!target) throw new Error('expected queue target');
    let reads = 0;
    spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
      const record = useGlobalSessionsStore.getState().entityById.get(id);
      if (!record) throw new Error('missing session');
      if (id === targetSession.id && ++reads === 2) {
        await Promise.resolve();
        useMessageQueueStore.getState().markSending(target, 'delivery');
      }
      return record;
    });
    expect(await runAutomaticSessionRetention(mergeAPIs())).toEqual({ archivedIds: [], deletedIds: [], failedIds: [] });
    expect(reads).toBe(2);
    expect(archive.mock.calls).toHaveLength(0);
  });

  test('a failed directory merge read does not block another directory', async () => {
    seed([session('failed-directory'), session('other-directory', { directory: '/other' })]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    archiveSuccess();
    const apis = mergeAPIs();
    let reads = 0;
    apis.git.getGitStatus.mockImplementation(async () => {
      if (++reads === 1) throw new Error('offline');
      return { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true };
    });
    const result = await runAutomaticSessionRetention(apis);
    expect(result.archivedIds).toEqual(['other-directory']);
    expect(result.failedIds).toContain('failed-directory');
  });

  test('a runtime switch during merge discovery cannot archive the destination', async () => {
    seed([session('switch-merge')]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    const archive = archiveSuccess();
    const apis = mergeAPIs();
    apis.github.prStatus.mockImplementation(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://other.test', runtimeKey: 'other-runtime' });
      return { connected: true, pr: { number: 1, title: '', url: '', state: 'merged', draft: false,
        base: 'main', head: 'feature', mergedAt: new Date(now).toISOString() } };
    });
    expect((await runAutomaticSessionRetention(apis)).archivedIds).toEqual([]);
    expect(archive.mock.calls).toHaveLength(0);
    expect(useSessionRetentionRunStore.getState().isRunning).toBe(false);
  });

  test('restore markers are runtime-scoped and malformed persisted markers grant no timestamp', () => {
    markSessionRestored('same-id', 123);
    expect(getSessionRestoredAt('same-id')).toBe(123);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://marker.test', runtimeKey: 'marker-runtime' });
    expect(getSessionRestoredAt('same-id')).toBe(0);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://retention.test', runtimeKey: 'retention-test' });
    expect(getSessionRestoredAt('same-id')).toBe(123);
    const malformed: Session['metadata'][] = [undefined, {}, { openchamber: null }, { openchamber: [] },
      { openchamber: { sessionRetentionRestoredAt: '123' } }, { openchamber: { sessionRetentionRestoredAt: -1 } }];
    for (const metadata of malformed) {
      expect(getPersistedSessionRestoredAt({ metadata })).toBe(0);
    }
  });

  test('a queue arriving during the final read protects the session', async () => {
    seed([session('queued-last')]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    const archive = archiveSuccess();
    let queued = false;
    spyOn(useMessageQueueStore.getState(), 'getQueueForTarget').mockImplementation((target) => (
      queued && target.sessionId === 'queued-last'
        ? [{ id: 'queued-message', content: 'Continue', text: 'Continue', createdAt: now }] : []
    ));
    let reads = 0;
    spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async () => {
      if (++reads > 1) queued = true;
      return {};
    });
    expect((await runAutomaticSessionRetention(mergeAPIs())).archivedIds).toEqual([]);
    expect(archive.mock.calls).toHaveLength(0);
  });

  test('an in-flight delivery protects an empty queue before status reports activity', async () => {
    seed([session('sending-last')]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    const archive = archiveSuccess();
    const target = createMessageQueueTarget('sending-last', '/retention-project');
    if (!target) throw new Error('expected queue target');
    let reads = 0;
    spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async () => {
      if (++reads > 1) useMessageQueueStore.getState().markSending(target, 'in-flight');
      return {};
    });
    expect((await runAutomaticSessionRetention(mergeAPIs())).archivedIds).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([]);
    expect(archive.mock.calls).toHaveLength(0);
    useMessageQueueStore.getState().clearSending(target, 'in-flight');
    spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
    expect((await runAutomaticSessionRetention(mergeAPIs())).archivedIds).toEqual(['sending-last']);
  });

  test('delivery restore during final activity confirmation wins over a prior merge', async () => {
    seed([session('delivery-last')]);
    useUIStore.setState({ sessionAutoArchiveOnMerge: true });
    const archive = archiveSuccess();
    let reads = 0;
    spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async () => {
      if (++reads > 1) markSessionRestored('delivery-last', now);
      return {};
    });
    expect((await runAutomaticSessionRetention(mergeAPIs())).archivedIds).toEqual([]);
    expect(archive.mock.calls).toHaveLength(0);
  });

  test('automatic deletion keeps a parent after its child fails and deletes unrelated archives', async () => {
    seed([...recentArchived, archived('auto-parent'), archived('auto-child', { parentID: 'auto-parent' }), archived('auto-other')]);
    useUIStore.setState({ sessionAutoDeleteArchivedEnabled: true });
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'auto-child');
    const result = await runAutomaticSessionRetention();
    expect(result.deletedIds).toEqual(['auto-other']);
    expect(result.failedIds).toEqual(['auto-child']);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['auto-child', 'auto-other']);
    expect(useGlobalSessionsStore.getState().entityById.has('auto-parent')).toBe(true);
  });

  test('automatic retention uses its independent policies and protects pinned sessions', async () => {
    const old = session('automatic-old');
    const pinned = session('automatic-pinned');
    seed([old, pinned]);
    useUIStore.setState({ sessionAutoArchiveEnabled: true, sessionAutoArchiveAfterDays: 30 });
    const archive = spyOn(sessionRoutes, 'requestSessionArchiveBatch').mockResolvedValue({
      outcome: 'archived', archived: [{ id: old.id, archivedAt: now }], failedIds: [],
    });
    const directory = resolveGlobalSessionDirectory(pinned);
    expect(directory).toBe('/retention-project');
    if (!directory) throw new Error('expected a session directory');
    const pinKey = getPinnedSessionKey('retention-test', directory, pinned.id);
    if (!pinKey) throw new Error('expected a pin key');
    useSessionPinnedStore.getState().setIds(new Set([pinKey]));
    const result = await runAutomaticSessionRetention();
    expect(result.archivedIds).toEqual([old.id]);
    expect(archive.mock.calls).toHaveLength(1);
    expect(archive.mock.calls[0]?.[1]).toEqual([old.id]);
  });

  test('automatic retention aborts when live status authority fails', async () => {
    seed([session('automatic-old')]);
    useUIStore.setState({ sessionAutoArchiveEnabled: true });
    spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue(null);
    const archive = spyOn(sessionRoutes, 'requestSessionArchiveBatch');
    const result = await runAutomaticSessionRetention();
    expect(result.failedIds).toContain('automatic-old');
    expect(archive.mock.calls).toHaveLength(0);
  });

});
