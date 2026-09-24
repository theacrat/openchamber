import { create } from 'zustand';
import type { Session } from "@/lib/opencode/model"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getBtwSessionID, isBtwSession } from '@/lib/sessionBtwMetadata';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from './session-ui-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { archiveSession, deleteSession } from './session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import type { GitHubAPI } from '@/lib/api/types';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { getPersistedSessionRestoredAt, getSessionRestoredAt } from './session-retention-state';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

const DAY_MS = 86_400_000;
export const RETENTION_KEEP_RECENT = 5;
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
  action: 'archive' | 'delete';
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

// Shared by the app's automatic runner and every Settings mount. Acquire before any await.
export const useSessionRetentionRunStore = create(() => ({ isRunning: false }));

let retentionRuntimeRevision = 0;
subscribeRuntimeEndpointWillChange(() => { retentionRuntimeRevision += 1; });

export type ArchivedDeletionPlan = {
  runtimeKey: string;
  runtimeRevision: number;
  targets: Session[];
  protectedCount: number;
};

export type ArchivedDeletionPreview =
  | { kind: 'ready'; plan: ArchivedDeletionPlan }
  | { kind: 'failure' | 'running' | 'runtime-changed' };

export type DeleteAllArchivedResult = {
  kind: 'complete' | 'discovery-failed' | 'running' | 'runtime-changed';
  deletedIds: string[];
  failedIds: string[];
  skippedIds: string[];
};

const sameRetentionRuntime = (owner: Pick<ArchivedDeletionPlan, 'runtimeKey' | 'runtimeRevision'>): boolean => (
  owner.runtimeKey === getRuntimeKey() && owner.runtimeRevision === retentionRuntimeRevision
);

async function loadArchivedDeletionAuthority(owner: Pick<ArchivedDeletionPlan, 'runtimeKey' | 'runtimeRevision'>) {
  await useGlobalSessionsStore.getState().loadSessions();
  if (!sameRetentionRuntime(owner)) throw new Error('Retention runtime changed');
  if (useGlobalSessionsStore.getState().status !== 'ready') throw new Error('Incomplete session list');
  await useMessageQueueStore.getState().hydrate();
  if (!sameRetentionRuntime(owner)) throw new Error('Retention runtime changed');
  const statuses = await opencodeClient.getActiveSessionStatuses();
  if (!sameRetentionRuntime(owner)) throw new Error('Retention runtime changed');
  if (statuses === null) throw new Error('Session activity unavailable');
  return new Set(Object.keys(statuses));
}

const archivedDeletionCandidates = (sessions: readonly Session[], activeIds: ReadonlySet<string>): string[] => {
  const protectedIds = automaticProtectedIds(sessions);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    if (!isArchived(session) || activeIds.has(session.id)) protectedIds.add(session.id);
  }
  // Set iteration visits newly inserted ancestors and terminates even for cycles.
  for (const id of protectedIds) {
    const parentId = byId.get(id)?.parentID;
    if (parentId) protectedIds.add(parentId);
  }
  return childFirstIds(sessions, sessions.filter((session) => isArchived(session) && !protectedIds.has(session.id)).map((session) => session.id));
};

export async function previewArchivedDeletion(): Promise<ArchivedDeletionPreview> {
  if (useSessionRetentionRunStore.getState().isRunning) return { kind: 'running' };
  const owner = { runtimeKey: getRuntimeKey(), runtimeRevision: retentionRuntimeRevision };
  useSessionRetentionRunStore.setState({ isRunning: true });
  try {
    const activeIds = await loadArchivedDeletionAuthority(owner);
    const sessions = [...useGlobalSessionsStore.getState().entityById.values()];
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const targets = archivedDeletionCandidates(sessions, activeIds).flatMap((id) => byId.get(id) ?? []);
    return { kind: 'ready', plan: { ...owner, targets, protectedCount: sessions.filter(isArchived).length - targets.length } };
  } catch {
    return { kind: sameRetentionRuntime(owner) ? 'failure' : 'runtime-changed' };
  } finally {
    useSessionRetentionRunStore.setState({ isRunning: false });
  }
}

const childFirstIds = (sessions: readonly Session[], candidateIds: readonly string[]): string[] => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const candidates = new Set(candidateIds);
  const remaining = new Map<string, number>();
  for (const session of sessions) {
    if (session.parentID && candidates.has(session.id) && candidates.has(session.parentID)) {
      remaining.set(session.parentID, (remaining.get(session.parentID) ?? 0) + 1);
    }
  }
  const ordered = candidateIds.filter((id) => !remaining.has(id));
  for (let index = 0; index < ordered.length; index += 1) {
    const parentId = byId.get(ordered[index])?.parentID;
    if (!parentId || !candidates.has(parentId)) continue;
    const next = (remaining.get(parentId) ?? 0) - 1;
    remaining.set(parentId, next);
    if (next === 0) ordered.push(parentId);
  }
  return ordered;
};

export async function deleteAllArchivedSessions(plan: ArchivedDeletionPlan): Promise<DeleteAllArchivedResult> {
  const result: DeleteAllArchivedResult = { kind: 'complete', deletedIds: [], failedIds: [], skippedIds: [] };
  if (!sameRetentionRuntime(plan)) return { ...result, kind: 'runtime-changed' };
  if (useSessionRetentionRunStore.getState().isRunning) return { ...result, kind: 'running' };
  useSessionRetentionRunStore.setState({ isRunning: true });
  try {
    for (const target of plan.targets) {
      let activeIds: ReadonlySet<string>;
      try {
        // Refresh hierarchy before each deletion: a new descendant must not be
        // deleted by OpenCode's cascade merely because its parent was confirmed.
        activeIds = await loadArchivedDeletionAuthority(plan);
      } catch {
        return { ...result, kind: sameRetentionRuntime(plan) ? 'discovery-failed' : 'runtime-changed' };
      }
      const id = target.id;
      const directory = resolveGlobalSessionDirectory(target);
      if (!directory) { result.skippedIds.push(id); continue; }
      try {
        const fresh = await opencodeClient.getSession(id, directory);
        const eligible = (): boolean => {
          if (!sameRetentionRuntime(plan)) return false;
          const state = useGlobalSessionsStore.getState();
          const current = state.entityById.get(id);
          const sessions = [...state.entityById.values()];
          return state.status === 'ready' && Boolean(current) && isArchived(fresh)
            && current?.time.archived === target.time.archived && current?.time.updated === target.time.updated
            && fresh.time.archived === target.time.archived && fresh.time.updated === target.time.updated
            && resolveGlobalSessionDirectory(current) === directory
            && !getBtwSessionID(fresh)
            && archivedDeletionCandidates(sessions, activeIds).includes(id)
            && !sessions.some((child) => child.parentID === id);
        };
        if (!eligible()) { result.skippedIds.push(id); continue; }
        const restoredAt = getSessionRestoredAt(id);
        let vetoed = false;
        const deleted = await deleteSession(id, { expectedRuntimeKey: plan.runtimeKey, beforeMutation: () => {
          vetoed = !eligible() || getSessionRestoredAt(id) !== restoredAt;
          return !vetoed;
        } });
        if (!sameRetentionRuntime(plan)) return { ...result, kind: 'runtime-changed' };
        if (vetoed) result.skippedIds.push(id);
        else if (deleted) result.deletedIds.push(id);
        else result.failedIds.push(id);
      } catch {
        if (!sameRetentionRuntime(plan)) return { ...result, kind: 'runtime-changed' };
        result.failedIds.push(id);
      }
    }
    return result;
  } finally {
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

const policyEnabled = (policy: AutomaticRetentionPolicy): boolean => automaticPolicies().some(
  (current) => current.kind === policy.kind
    && (current.kind === 'merged' || (policy.kind !== 'merged' && current.days === policy.days)),
);

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
    if (!directory || isBtwSession(session) || getBtwSessionID(session) || blocking.has(session.id)
      || (excludePinned && isSessionPinned(pins, directory, session.id))
      || (target && (queue.getQueueForTarget(target).length > 0
        || (queue.sendingIds[getMessageQueueKey(target)]?.length ?? 0) > 0))) {
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

const hasUnarchivedDescendant = (sessions: readonly Session[], sessionId: string): boolean => {
  const childrenByParent = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID) ?? [];
    children.push(session);
    childrenByParent.set(session.parentID, children);
  }
  const queue = [...(childrenByParent.get(sessionId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const child = queue.shift();
    if (!child || seen.has(child.id)) continue;
    seen.add(child.id);
    if (!isArchived(child)) return true;
    queue.push(...(childrenByParent.get(child.id) ?? []));
  }
  return false;
};

async function mergedAfterLastActivity(
  session: Session,
  github: Pick<GitHubAPI, 'prStatus'>,
  git: Pick<ReturnType<typeof useRuntimeAPIs>['git'], 'getGitStatus'>,
  reads: Map<string, Promise<number>>,
): Promise<boolean> {
  const directory = resolveGlobalSessionDirectory(session);
  if (!directory) return false;
  let read = reads.get(directory);
  if (!read) {
    read = runBackgroundNetworkTask(async () => {
      const status = await git.getGitStatus(directory, { mode: 'light' });
      if (!status.current) return 0;
      const result = await github.prStatus(directory, status.current);
      return result.pr?.state === 'merged' && result.pr.mergedAt ? Date.parse(result.pr.mergedAt) : 0;
    });
    reads.set(directory, read);
  }
  const mergedAt = await read;
  const lastActivity = Math.max(session.time.updated, getSessionRestoredAt(session.id), getPersistedSessionRestoredAt(session));
  return Number.isFinite(mergedAt) && mergedAt > lastActivity;
}

export async function runAutomaticSessionRetention({ github, git }: {
  github?: Pick<GitHubAPI, 'prStatus'>;
  git?: Pick<ReturnType<typeof useRuntimeAPIs>['git'], 'getGitStatus'>;
} = {}): Promise<AutomaticRetentionResult> {
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
    const mergeReads = new Map<string, Promise<number>>();
    const now = Date.now();
    for (const policy of policies) {
      const ids = policy.kind === 'merged'
        ? sessions.filter((session) => !isArchived(session) && !protectedIds.has(session.id)
          && !activeSessionIds.has(session.id)).map((session) => session.id)
        : buildSessionRetentionCandidates({
          sessions, currentSessionId: null, cutoffDays: policy.days,
          action: policy.kind === 'archived' ? 'delete' : 'archive',
          onlyArchived: policy.kind === 'archived', activeSessionIds, protectedSessionIds: protectedIds, now,
        });
      for (const id of ids) {
        if (!currentRuntime()) return result;
        if (!policyEnabled(policy)) break;
        const state = useGlobalSessionsStore.getState();
        const session = state.entityById.get(id);
        if (!session || isArchived(session) !== (policy.kind === 'archived')) continue;
        try {
          const directory = resolveGlobalSessionDirectory(session);
          if (!directory) {
            result.failedIds.push(id);
            continue;
          }
          const fresh = await opencodeClient.getSession(id, directory);
          if (!currentRuntime()) return result;
          if (fresh.time.updated !== session.time.updated || fresh.time.archived !== session.time.archived) continue;
          const restoredAt = getSessionRestoredAt(id);
          if (policy.kind === 'merged' && (!github || !git || !await mergedAfterLastActivity(fresh, github, git, mergeReads))) continue;
          if (!currentRuntime()) return result;
          const latestStatuses = await opencodeClient.getActiveSessionStatuses();
          if (!currentRuntime()) return result;
          if (latestStatuses === null) throw new Error('Session activity could not be confirmed');
          const liveIds = new Set(Object.keys(latestStatuses));
          for (const activeId of liveIds) {
            const parentId = useGlobalSessionsStore.getState().entityById.get(activeId)?.parentID;
            if (parentId) liveIds.add(parentId);
          }
          if (liveIds.has(id)) continue;
          const isStillEligible = (): boolean => {
            if (!currentRuntime() || !policyEnabled(policy) || getSessionRestoredAt(id) !== restoredAt) return false;
            const current = useGlobalSessionsStore.getState();
            if (current.status !== 'ready' || current.entityById.get(id) !== session) return false;
            const timestamp = policy.kind === 'archived' ? fresh.time.archived : fresh.time.updated;
            if (policy.kind !== 'merged' && (!timestamp || timestamp >= Date.now() - policy.days * DAY_MS)) return false;
            const currentSessions = [...current.entityById.values()];
            if (automaticProtectedIds(currentSessions).has(id)) return false;
            // The host cascades archive into descendants. Each child must earn
            // archive eligibility independently before its parent may run.
            return policy.kind === 'archived'
              ? !currentSessions.some((child) => child.parentID === id)
              : !hasUnarchivedDescendant(currentSessions, id);
          };
          if (!isStillEligible()) continue;
          let admissionSkipped = false;
          const beforeMutation = (): boolean => {
            admissionSkipped = !isStillEligible();
            return !admissionSkipped;
          };
          const completed = policy.kind === 'archived'
            ? await deleteSession(id, { expectedRuntimeKey: runtimeKey, beforeMutation })
            : await archiveSession(id, runtimeKey, beforeMutation);
          if (admissionSkipped) continue;
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
