import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { ensureGlobalSessionsLoaded, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  buildSessionRetentionCandidates,
  RETENTION_INTERVAL_MS,
  RETENTION_KEEP_RECENT,
  runSessionRetentionCleanup,
  useSessionRetentionRunStore,
  AUTOMATIC_RETENTION_INTERVAL_MS,
  runAutomaticSessionRetention,
} from '@/sync/session-retention';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

const EMPTY_SESSIONS: Session[] = [];
type CleanupOptions = { autoRun?: boolean; enabled?: boolean };

export const useSessionAutoCleanup = ({ autoRun = true, enabled = true }: CleanupOptions = {}) => {
  const { github, git } = useRuntimeAPIs();
  const automaticEnabled = useUIStore((state) => state.sessionAutoArchiveEnabled
    || state.sessionAutoArchiveOnMerge || state.sessionAutoDeleteArchivedEnabled);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isLoading = useSessionUIStore((state) => state.isLoading);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const onlyArchived = useUIStore((state) => state.sessionRetentionOnlyArchived);
  const action = useUIStore((state) => state.sessionRetentionOnlyArchived ? 'delete' : state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const needsGlobalSessions = enabled && (!autoRun || autoDeleteEnabled);
  const activeSessions = useGlobalSessionsStore((state) => needsGlobalSessions ? state.activeSessions : EMPTY_SESSIONS);
  const archivedSessions = useGlobalSessionsStore((state) => needsGlobalSessions ? state.archivedSessions : EMPTY_SESSIONS);
  const status = useGlobalSessionsStore((state) => state.status);
  const activeSessionIds = useGlobalSessionStatusStore((state) => state.activeSessionIds);
  const isRunning = useSessionRetentionRunStore((state) => state.isRunning);

  React.useEffect(() => {
    if (needsGlobalSessions) void ensureGlobalSessionsLoaded();
  }, [needsGlobalSessions]);

  const candidates = React.useMemo(() => buildSessionRetentionCandidates({
    sessions: [...activeSessions, ...archivedSessions],
    currentSessionId,
    cutoffDays: autoDeleteAfterDays,
    action,
    onlyArchived,
    activeSessionIds,
  }), [activeSessions, archivedSessions, currentSessionId, autoDeleteAfterDays, action, onlyArchived, activeSessionIds]);

  React.useEffect(() => {
    if (!enabled || !autoRun || !autoDeleteEnabled || autoDeleteAfterDays <= 0
      || isLoading || status !== 'ready' || isRunning) return;
    if (autoDeleteLastRunAt && Date.now() - autoDeleteLastRunAt < RETENTION_INTERVAL_MS) return;
    void runSessionRetentionCleanup().catch((error) => {
      console.error('[SessionRetention] Cleanup failed', error);
    });
  }, [enabled, autoRun, autoDeleteEnabled, autoDeleteAfterDays, isLoading, status, isRunning, autoDeleteLastRunAt]);

  React.useEffect(() => {
    if (!enabled || !autoRun || !automaticEnabled) return;
    const run = () => {
      if (document.visibilityState !== 'visible') return;
      void runAutomaticSessionRetention({ github, git }).catch((error) => {
        console.error('[SessionRetention] Automatic cleanup failed', error);
      });
    };
    run();
    const timer = window.setInterval(run, AUTOMATIC_RETENTION_INTERVAL_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [enabled, autoRun, automaticEnabled, github, git]);

  return {
    candidates,
    isRunning,
    status,
    runCleanup: runSessionRetentionCleanup,
    keepRecentCount: RETENTION_KEEP_RECENT,
    action,
  };
};
