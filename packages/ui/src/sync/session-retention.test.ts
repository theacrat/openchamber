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
import { buildSessionRetentionCandidates, runAutomaticSessionRetention, runSessionRetentionCleanup, useSessionRetentionRunStore } from './session-retention';
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
  useUIStore.setState({ autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'delete', sessionRetentionOnlyArchived: false, autoDeleteLastRunAt: 0 });
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

  test('claims the shared lock before loading and releases it after failure', async () => {
    let finish!: () => void;
    const loading = new Promise<void>((resolve) => { finish = resolve; });
    seed([session('old')]);
    const load = spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(async () => {
      await loading;
      throw new Error('offline');
    });
    load.mock.calls.length = 0;
    const first = runSessionRetentionCleanup({ force: true });
    expect(useSessionRetentionRunStore.getState().isRunning).toBe(true);
    expect((await runSessionRetentionCleanup({ force: true })).skippedReason).toBe('running');
    expect(load.mock.calls).toHaveLength(1);
    finish();
    await expect(first).rejects.toThrow('offline');
    expect(useSessionRetentionRunStore.getState().isRunning).toBe(false);
  });

  test('refuses a failed global load even when fallback sessions remain', async () => {
    seed([session('old')]);
    useGlobalSessionsStore.setState({ status: 'error' });
    const remove = spyOn(opencodeClient, 'deleteSession');
    await expect(runSessionRetentionCleanup({ force: true })).rejects.toThrow('complete session list');
    expect(remove.mock.calls).toHaveLength(0);
    expect(useGlobalSessionsStore.getState().entityById.has('old')).toBe(true);
  });

  test('requests fresh authority instead of relying on a previously loaded candidate', async () => {
    seed([session('old')]);
    const remove = spyOn(opencodeClient, 'deleteSession');
    spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(async () => {
      seed([session('old', { time: { created: now - 60 * day, updated: now } })]);
      const state = useGlobalSessionsStore.getState();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    });
    expect((await runSessionRetentionCleanup({ force: true })).skippedReason).toBe('no-candidates');
    expect(remove.mock.calls).toHaveLength(0);
  });

  test('treats an authoritative 404 as completed and removes stale cached state', async () => {
    seed([session('gone')]);
    spyOn(opencodeClient, 'deleteSession').mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['gone']);
    expect(result.failedIds).toEqual([]);
    expect(useGlobalSessionsStore.getState().entityById.has('gone')).toBe(false);
  });

  test('does not accept a false delete confirmation, and preserves unrelated successes', async () => {
    seed([session('bad'), session('good')]);
    spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'bad');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['good']);
    expect(result.failedIds).toEqual(['bad']);
    expect(useGlobalSessionsStore.getState().entityById.has('bad')).toBe(true);
    expect(useGlobalSessionsStore.getState().entityById.has('good')).toBe(false);
  });

  test('keeps a failed child and its ancestors without preventing unrelated deletion', async () => {
    seed([session('root'), session('child', { parentID: 'root' }), session('leaf', { parentID: 'child' }), session('other')]);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'leaf');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['other']);
    expect(result.failedIds).toEqual(['leaf', 'child', 'root']);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['leaf', 'other']);
  });

  test('rechecks selection, recent activity and new descendants during the batch', async () => {
    seed([session('first'), session('selected'), session('updated'), session('parent')]);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async () => {
      useSessionUIStore.setState({ currentSessionId: 'selected' });
      useGlobalSessionsStore.getState().upsertSessions([
        session('updated', { time: { created: 1, updated: now } }),
        session('new-child', { parentID: 'parent', time: { created: now, updated: now } }),
      ]);
      return true;
    });
    expect((await runSessionRetentionCleanup({ force: true })).completedIds).toEqual(['first']);
    expect(remove.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().entityById.has('parent')).toBe(true);
  });

  test('stops at a runtime switch without reconciling the destination or its cooldown', async () => {
    seed([session('first'), session('second')]);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://retention-other.test', runtimeKey: 'retention-other' });
      seed([session('first'), session('second')]);
      useUIStore.setState({ autoDeleteLastRunAt: 123 });
      return true;
    });
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual([]);
    expect(result.failedIds).toEqual(['first', 'second']);
    expect(remove.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().entityById.has('first')).toBe(true);
    expect(useUIStore.getState().autoDeleteLastRunAt).toBe(123);
  });

  test('archives through the canonical action and keeps the whole record with the server stamp', async () => {
    const old = session('old');
    seed([old]);
    useUIStore.setState({ sessionRetentionAction: 'archive' });
    spyOn(sessionRoutes, 'requestSessionArchiveBatch')
      .mockResolvedValue({ outcome: 'archived', archived: [{ id: 'old', archivedAt: now }], failedIds: [] });
    expect((await runSessionRetentionCleanup({ force: true })).completedIds).toEqual(['old']);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([{ ...old, time: { ...old.time, archived: now } }]);
  });

  test('processes 850 hierarchical sessions with one confirmed delete per candidate', async () => {
    const sessions = Array.from({ length: 850 }, (_, index) => {
      const item = session(`old-${index}`);
      if (index % 10) item.parentID = `old-${index - index % 10}`;
      return item;
    });
    seed(sessions);
    const existing = new Set(sessions.map((item) => item.id));
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => {
      if (!existing.has(id)) throw Object.assign(new Error('cascade already deleted'), { status: 404 });
      existing.delete(id);
      for (const child of sessions) if (child.parentID === id) existing.delete(child.id);
      return true;
    });
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toHaveLength(850);
    expect(result.failedIds).toEqual([]);
    expect(remove.mock.calls).toHaveLength(850);
    expect(existing.size).toBe(0);
    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(5);
  });
});

describe('archived-only retention', () => {
  const archivedCandidates = (sessions: Session[]) => buildSessionRetentionCandidates({
    sessions: [...recentArchived, ...sessions], cutoffDays: 30, currentSessionId: null,
    action: 'archive', onlyArchived: true, activeSessionIds: new Set(), now,
  });

  test('filters only archived sessions and uses archive time instead of last activity', () => {
    expect(archivedCandidates([
      archived('old-archive', { time: { created: 1, updated: now, archived: now - 40 * day } }),
      archived('new-archive', { time: { created: 1, updated: 2, archived: now - 2 * day } }),
      session('unarchived'),
      session('restored', { time: { created: 1, updated: 2, archived: 0 } }),
    ])).toEqual(['old-archive']);
  });

  test('preserves the five most recently archived sessions even when all are expired', () => {
    const sessions = Array.from({ length: 7 }, (_, index) => archived(`archived-${index}`, {
      time: { created: 1, updated: now, archived: now - (40 + index) * day },
    }));
    expect(buildSessionRetentionCandidates({
      sessions, cutoffDays: 30, currentSessionId: null, action: 'delete', onlyArchived: true, activeSessionIds: new Set(), now,
    })).toEqual(['archived-5', 'archived-6']);
  });

  test('protects parents of unarchived or recently archived descendants', () => {
    expect(archivedCandidates([
      archived('parent'), session('active-child', { parentID: 'parent' }),
      archived('recent-parent'), { ...recentArchived[0], parentID: 'recent-parent' },
      archived('unrelated'),
    ])).toEqual(['unrelated']);
  });

  test('forces deletion in core even if a stale setting still requests archive', async () => {
    seed([...recentArchived, archived('parent'), archived('child', { parentID: 'parent' }), session('unarchived')]);
    useUIStore.setState({ sessionRetentionOnlyArchived: true, sessionRetentionAction: 'archive' });
    const remove = spyOn(opencodeClient, 'deleteSession').mockResolvedValue(true);
    const update = spyOn(sessionRoutes, 'requestSessionArchiveBatch');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.action).toBe('delete');
    expect(result.completedIds).toEqual(['child', 'parent']);
    expect(result.failedIds).toEqual([]);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['child', 'parent']);
    expect(update.mock.calls).toHaveLength(0);
    expect(useGlobalSessionsStore.getState().entityById.has('unarchived')).toBe(true);
    expect(useGlobalSessionsStore.getState().archivedSessions).toHaveLength(5);
  });

  test('keeps failed archived descendants and reports their blocked ancestors', async () => {
    seed([...recentArchived, archived('parent'), archived('child', { parentID: 'parent' }), archived('other')]);
    useUIStore.getState().setSessionRetentionOnlyArchived(true);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'child');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['other']);
    expect(result.failedIds).toEqual(['child', 'parent']);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['child', 'other']);
    expect(useGlobalSessionsStore.getState().entityById.has('parent')).toBe(true);
  });

  test('skips sessions restored during cleanup and parents with newly archived children', async () => {
    seed([...recentArchived, archived('first'), archived('restored'), archived('parent')]);
    useUIStore.getState().setSessionRetentionOnlyArchived(true);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async () => {
      useGlobalSessionsStore.getState().upsertSessions([
        session('restored', { time: { created: 1, updated: 2, archived: 0 } }),
        archived('new-child', { parentID: 'parent', time: { created: now, updated: now, archived: now } }),
      ]);
      return true;
    });
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['first']);
    expect(result.failedIds).toEqual([]);
    expect(remove.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().entityById.has('parent')).toBe(true);
    expect(useGlobalSessionsStore.getState().entityById.has('restored')).toBe(true);
  });
});
