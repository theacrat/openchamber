import { create } from 'zustand';
import type { Session } from "@/lib/opencode/model"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getBtwSessionID } from '@/lib/sessionBtwMetadata';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore, type SessionRetentionAction } from '@/stores/useUIStore';
import { useSessionUIStore } from './session-ui-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { archiveSession, deleteSession } from './session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import type { GitHubAPI } from '@/lib/api/types';
import { getLinkedIssues } from '@/lib/linkedIssues';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { getPersistedSessionRestoredAt, getSessionRestoredAt } from './session-retention-state';

const DAY_MS = 86_400_000;
export const RETENTION_KEEP_RECENT = 5;
export const RETENTION_INTERVAL_MS = DAY_MS;
export const AUTOMATIC_RETENTION_INTERVAL_MS = 5 * 60_000;

// A record without timestamps has no age to compare, so it never qualifies.
const retentionTimestamp = (session: Session, onlyArchived: boolean): number => (
  onlyArchived ? session.time?.archived ?? 0 : session.time?.updated ?? session.time?.created ?? 0
);
const isArchived = (session: Session): boolean => Boolean(session.time?.archived);

const isOlderThanCutoff = (session: Session, cutoff: number, onlyArchived: boolean): boolean => {
  const timestamp = retentionTimestamp(session, onlyArchived);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff;
};

type CandidateOptions = {
  sessions: readonly Session[];
  currentSessionId: string | null;
  cutoffDays: number;
  action: SessionRetentionAction;
  onlyArchived?: boolean;
  activeSessionIds: ReadonlySet<string>;
  protectedSessionIds?: ReadonlySet<string>;
  keepRecent?: number;
  now?: number;
};

/** The unselected scope stays protected, including from cascading parent deletion. */
export function buildSessionRetentionCandidates({
  sessions, currentSessionId, cutoffDays, action, onlyArchived = false, activeSessionIds,
  protectedSessionIds = new Set(), keepRecent = RETENTION_KEEP_RECENT, now = Date.now(),
}: CandidateOptions): string[] {
  if (!Number.isFinite(cutoffDays) || cutoffDays < 1) return [];
  const cutoff = now - cutoffDays * DAY_MS;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const sorted = sessions.filter((session) => isArchived(session) === onlyArchived)
    .sort((a, b) => retentionTimestamp(b, onlyArchived) - retentionTimestamp(a, onlyArchived));
  const protectedIds = new Set(sorted.slice(0, keepRecent).map((session) => session.id));
  for (const session of sessions) {
    if (isArchived(session) !== onlyArchived || getBtwSessionID(session) || session.id === currentSessionId
      || protectedSessionIds.has(session.id) || activeSessionIds.has(session.id) || !isOlderThanCutoff(session, cutoff, onlyArchived)) {
      protectedIds.add(session.id);
    }
  }
  if (action === 'delete' || onlyArchived) {
    // OpenCode deletes the whole subtree. Protect every ancestor of a retained session.
    for (const id of protectedIds) {
      const parentId = byId.get(id)?.parentID;
      if (parentId) protectedIds.add(parentId);
    }
  }
  const candidates = sorted.filter((session) => !protectedIds.has(session.id));
  if (action === 'archive' && !onlyArchived) return candidates.map((session) => session.id);

  // Children first: each request deletes one eligible session, and a failed child
  // can prevent its parent from bypassing that failure with a cascading delete.
  const ids = new Set(candidates.map((session) => session.id));
  const childrenLeft = new Map<string, number>();
  for (const session of candidates) {
    if (session.parentID && ids.has(session.parentID)) {
      childrenLeft.set(session.parentID, (childrenLeft.get(session.parentID) ?? 0) + 1);
    }
  }
  const ordered = candidates.filter((session) => !childrenLeft.has(session.id)).map((session) => session.id);
  for (let index = 0; index < ordered.length; index += 1) {
    const parentId = byId.get(ordered[index])?.parentID;
    if (!parentId || !ids.has(parentId)) continue;
    const remaining = (childrenLeft.get(parentId) ?? 0) - 1;
    childrenLeft.set(parentId, remaining);
    if (remaining === 0) ordered.push(parentId);
  }
  // Cyclic/malformed hierarchies never become leaves and cannot be deleted.
  return ordered;
}

type SessionRetentionResult = {
  completedIds: string[];
  failedIds: string[];
  action: SessionRetentionAction;
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-candidates' | 'running' | 'runtime-changed';
};

// Shared by the app's automatic runner and every Settings mount. Acquire before any await.
export const useSessionRetentionRunStore = create(() => ({ isRunning: false }));

export async function runSessionRetentionCleanup({ force = false } = {}): Promise<SessionRetentionResult> {
  const settings = useUIStore.getState();
  const onlyArchived = settings.sessionRetentionOnlyArchived;
  const action = onlyArchived ? 'delete' : settings.sessionRetentionAction;
  const result: SessionRetentionResult = { completedIds: [], failedIds: [], action };
  if (useSessionRetentionRunStore.getState().isRunning) return { ...result, skippedReason: 'running' };
  if (!Number.isFinite(settings.autoDeleteAfterDays) || settings.autoDeleteAfterDays < 1
    || (!force && !settings.autoDeleteEnabled)) return { ...result, skippedReason: 'disabled' };
  if (!force && useSessionUIStore.getState().isLoading) return { ...result, skippedReason: 'loading' };
  const now = Date.now();
  if (!force && settings.autoDeleteLastRunAt && now - settings.autoDeleteLastRunAt < RETENTION_INTERVAL_MS) {
    return { ...result, skippedReason: 'cooldown' };
  }

  const runtimeKey = getRuntimeKey();
  let runtimeChanged = false;
  const unsubscribe = subscribeRuntimeEndpointWillChange(() => { runtimeChanged = true; });
  const isCurrentRuntime = () => !runtimeChanged && getRuntimeKey() === runtimeKey;
  useSessionRetentionRunStore.setState({ isRunning: true });
  try {
    await useGlobalSessionsStore.getState().loadSessions();
    if (!isCurrentRuntime()) return { ...result, skippedReason: 'runtime-changed' };
    if (useGlobalSessionsStore.getState().status !== 'ready') {
      throw new Error('Session retention requires a complete session list');
    }
    const candidateIds = buildSessionRetentionCandidates({
      sessions: [...useGlobalSessionsStore.getState().entityById.values()],
      currentSessionId: useSessionUIStore.getState().currentSessionId,
      cutoffDays: settings.autoDeleteAfterDays,
      action,
      onlyArchived,
      activeSessionIds: useGlobalSessionStatusStore.getState().activeSessionIds,
      now,
    });
    if (candidateIds.length === 0) return { ...result, skippedReason: 'no-candidates' };

    const failedIds = new Set<string>();
    let archivedSnapshot: readonly Session[] | undefined;
    let archivedChildrenByParentId = new Map<string, string[]>();
    for (const [index, id] of candidateIds.entries()) {
      if (!isCurrentRuntime()) {
        result.failedIds.push(...candidateIds.slice(index));
        break;
      }
      const state = useGlobalSessionsStore.getState();
      const session = state.entityById.get(id);
      if (!session) continue;
      if (isArchived(session) !== onlyArchived || getBtwSessionID(session) || session.id === useSessionUIStore.getState().currentSessionId
        || useGlobalSessionStatusStore.getState().activeSessionIds.has(id)
        || !isOlderThanCutoff(session, now - settings.autoDeleteAfterDays * DAY_MS, onlyArchived)) continue;
      if (action === 'delete') {
        if (archivedSnapshot !== state.archivedSessions) {
          archivedSnapshot = state.archivedSessions;
          archivedChildrenByParentId = new Map();
          for (const archived of archivedSnapshot) {
            if (!archived.parentID) continue;
            const children = archivedChildrenByParentId.get(archived.parentID);
            if (children) children.push(archived.id);
            else archivedChildrenByParentId.set(archived.parentID, [archived.id]);
          }
        }
        // Planned children ran first. Any child still present either failed,
        // became protected, or arrived mid-run. Never delete it via its parent.
        const children = [
          ...(state.structure.activeChildrenByParentId.get(id) ?? []),
          ...(archivedChildrenByParentId.get(id) ?? []),
        ];
        if (children.length > 0) {
          if (children.some((childId) => failedIds.has(childId))) {
            failedIds.add(id);
            result.failedIds.push(id);
          }
          continue;
        }
      }
      if (!resolveGlobalSessionDirectory(session)) {
        failedIds.add(id);
        result.failedIds.push(id);
        continue;
      }
      const completed = action === 'archive'
        ? await archiveSession(id, runtimeKey)
        : await deleteSession(id, { expectedRuntimeKey: runtimeKey });
      if (completed) result.completedIds.push(id);
      else {
        failedIds.add(id);
        result.failedIds.push(id);
      }
    }
    return result;
  } finally {
    if (isCurrentRuntime()) settings.setAutoDeleteLastRunAt(Date.now());
    unsubscribe();
    useSessionRetentionRunStore.setState({ isRunning: false });
  }
}

type AutomaticRetentionPolicy =
  | { kind: 'inactive'; days: number }
  | { kind: 'merged' }
  | { kind: 'archived'; days: number };

type AutomaticRetentionResult = {
  archivedIds: string[];
  deletedIds: string[];
  failedIds: string[];
};

const automaticPolicies = (): AutomaticRetentionPolicy[] => {
  const settings = useUIStore.getState();
  const policies: AutomaticRetentionPolicy[] = [];
  if (settings.sessionAutoArchiveEnabled) policies.push({ kind: 'inactive', days: settings.sessionAutoArchiveAfterDays });
  if (settings.sessionAutoArchiveOnMerge) policies.push({ kind: 'merged' });
  if (settings.sessionAutoDeleteArchivedEnabled) policies.push({ kind: 'archived', days: settings.sessionAutoDeleteArchivedAfterDays });
  return policies;
};

const automaticProtectedIds = (sessions: readonly Session[]): Set<string> => {
  const protectedIds = new Set(useGlobalSessionStatusStore.getState().activeSessionIds);
  const selected = useSessionUIStore.getState().currentSessionId;
  if (selected) protectedIds.add(selected);
  const pins = useSessionPinnedStore.getState().ids;
  const excludePinned = useUIStore.getState().sessionRetentionExcludePinned;
  const blocking = useGlobalBlockingRequestsStore.getState().bySession;
  const queue = useMessageQueueStore.getState();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    const target = createMessageQueueTarget(session.id, directory);
    if (!directory || getBtwSessionID(session) || blocking.has(session.id)
      || (excludePinned && isSessionPinned(pins, directory, session.id))
      || (target && queue.getQueueForTarget(target).length > 0)) {
      protectedIds.add(session.id);
    }
  }
  const byId = new Map(sessions.map((session) => [session.id, session]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of protectedIds) {
      const parentId = byId.get(id)?.parentID;
      if (parentId && !protectedIds.has(parentId)) {
        protectedIds.add(parentId);
        changed = true;
      }
    }
  }
  return protectedIds;
};

const linkedPulls = (session: Session) => getLinkedIssues(session).filter(
  (issue) => issue.kind === 'pull' || (issue.kind === 'guest' && issue.thread === 'pull'),
);

async function mergedAfterLastActivity(
  session: Session,
  github: GitHubAPI,
  reads: Map<string, Promise<number | null>>,
): Promise<boolean> {
  const pulls = linkedPulls(session);
  if (pulls.length === 0) return false;
  let latestMerge = 0;
  for (const pull of pulls) {
    if (pull.kind === 'linear') return false;
    const guestNumber = pull.kind === 'guest' ? Number(pull.identifier) : pull.number;
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(pull.url);
    if (!match || !Number.isSafeInteger(guestNumber) || Number(match[3]) !== guestNumber) return false;
    let read = reads.get(pull.url);
    if (!read) {
      read = runBackgroundNetworkTask(async () => {
        const context = await github.prMergeState(session.directory, guestNumber, { owner: match[1], repo: match[2] });
        if (!context.connected || context.state !== 'merged' || context.url !== pull.url
          || context.number !== guestNumber || !context.mergedAt) return null;
        const timestamp = Date.parse(context.mergedAt);
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
      });
      reads.set(pull.url, read);
    }
    const mergedAt = await read;
    if (mergedAt === null) return false;
    latestMerge = Math.max(latestMerge, mergedAt);
  }
  return Math.max(session.time.updated, getSessionRestoredAt(session.id), getPersistedSessionRestoredAt(session)) <= latestMerge;
}

export async function runAutomaticSessionRetention({ github }: { github?: GitHubAPI } = {}): Promise<AutomaticRetentionResult> {
  const result: AutomaticRetentionResult = { archivedIds: [], deletedIds: [], failedIds: [] };
  const policies = automaticPolicies();
  if (policies.length === 0 || useSessionRetentionRunStore.getState().isRunning) return result;
  const runtimeKey = getRuntimeKey();
  let changed = false;
  const unsubscribe = subscribeRuntimeEndpointWillChange(() => { changed = true; });
  const currentRuntime = () => !changed && getRuntimeKey() === runtimeKey;
  useSessionRetentionRunStore.setState({ isRunning: true });
  try {
    try {
      await useGlobalSessionsStore.getState().loadSessions();
    } catch {
      result.failedIds.push(...useGlobalSessionsStore.getState().entityById.keys());
      return result;
    }
    if (!currentRuntime()) return result;
    if (useGlobalSessionsStore.getState().status !== 'ready') {
      result.failedIds.push(...useGlobalSessionsStore.getState().entityById.keys());
      return result;
    }
    await useMessageQueueStore.getState().hydrate();
    if (!currentRuntime()) return result;
    const sessions = [...useGlobalSessionsStore.getState().entityById.values()];
    const statuses = await opencodeClient.getActiveSessionStatuses();
    if (!currentRuntime()) return result;
    if (statuses === null) {
      result.failedIds.push(...sessions.map((session) => session.id));
      return result;
    }
    const activeSessionIds = new Set(Object.keys(statuses));
    const protectedIds = automaticProtectedIds(sessions);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const id of activeSessionIds) {
      protectedIds.add(id);
      const parentId = byId.get(id)?.parentID;
      if (parentId) activeSessionIds.add(parentId);
    }
    const mergeReads = new Map<string, Promise<number | null>>();
    const now = Date.now();
    for (const policy of policies) {
      const ids = policy.kind === 'merged'
        ? sessions.filter((session) => !isArchived(session) && !protectedIds.has(session.id)
          && !activeSessionIds.has(session.id) && linkedPulls(session).length > 0).map((session) => session.id)
        : buildSessionRetentionCandidates({
          sessions, currentSessionId: null, cutoffDays: policy.days,
          action: policy.kind === 'archived' ? 'delete' : 'archive',
          onlyArchived: policy.kind === 'archived', activeSessionIds, protectedSessionIds: protectedIds, now,
        });
      for (const id of ids) {
        if (!currentRuntime()) return result;
        if (!automaticPolicies().some((current) => current.kind === policy.kind
          && (current.kind === 'merged' || (policy.kind !== 'merged' && current.days === policy.days)))) break;
        const state = useGlobalSessionsStore.getState();
        const session = state.entityById.get(id);
        if (!session || isArchived(session) !== (policy.kind === 'archived')) continue;
        try {
          const currentSettings = useUIStore.getState();
          const enabled = policy.kind === 'inactive'
            ? currentSettings.sessionAutoArchiveEnabled && currentSettings.sessionAutoArchiveAfterDays === policy.days
            : policy.kind === 'merged'
              ? currentSettings.sessionAutoArchiveOnMerge
              : currentSettings.sessionAutoDeleteArchivedEnabled && currentSettings.sessionAutoDeleteArchivedAfterDays === policy.days;
          if (!enabled) break;
          if (policy.kind === 'merged' && (!github || !await mergedAfterLastActivity(session, github, mergeReads))) continue;
          if (!currentRuntime()) return result;
        const directory = resolveGlobalSessionDirectory(session);
        if (!directory) continue;
        const fresh = await opencodeClient.getSession(id, directory);
          if (!currentRuntime()) return result;
          if (fresh.time.updated !== session.time.updated || fresh.time.archived !== session.time.archived
            || (policy.kind === 'merged' && JSON.stringify(linkedPulls(fresh)) !== JSON.stringify(linkedPulls(session)))) continue;
          const latestStatuses = await opencodeClient.getActiveSessionStatuses();
          if (!currentRuntime()) return result;
          if (latestStatuses === null) throw new Error('Session activity could not be confirmed');
          const current = useGlobalSessionsStore.getState();
          if (current.status !== 'ready' || current.entityById.get(id) !== session) continue;
          const currentTimestamp = policy.kind === 'archived' ? session.time.archived : session.time.updated;
          const currentCutoff = policy.kind === 'merged' ? 0 : Date.now() - policy.days * DAY_MS;
          if (policy.kind !== 'merged' && (!currentTimestamp || currentTimestamp >= currentCutoff)) continue;
          if (automaticProtectedIds([...current.entityById.values()]).has(id) || latestStatuses[id]) continue;
          const liveIds = new Set(Object.keys(latestStatuses));
          for (const activeId of liveIds) {
            const parentId = current.entityById.get(activeId)?.parentID;
            if (parentId) liveIds.add(parentId);
          }
          if (liveIds.has(id)) continue;
          if (policy.kind === 'archived' && [...current.entityById.values()].some((child) => child.parentID === id)) continue;
          const completed = policy.kind === 'archived'
            ? await deleteSession(id, { expectedRuntimeKey: runtimeKey })
            : await archiveSession(id, runtimeKey);
          if (!completed) result.failedIds.push(id);
          else if (policy.kind === 'archived') result.deletedIds.push(id);
          else result.archivedIds.push(id);
        } catch {
          result.failedIds.push(id);
        }
      }
    }
    return result;
  } finally {
    unsubscribe();
    useSessionRetentionRunStore.setState({ isRunning: false });
  }
}
