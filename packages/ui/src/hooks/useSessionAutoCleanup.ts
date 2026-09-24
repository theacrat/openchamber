import React from 'react';
import { AUTOMATIC_RETENTION_INTERVAL_MS, runAutomaticSessionRetention } from '@/sync/session-retention';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

export const useSessionAutoCleanup = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const { github, git } = useRuntimeAPIs();
  const automaticEnabled = useUIStore((state) => state.sessionAutoArchiveEnabled
    || state.sessionAutoArchiveOnMerge || state.sessionAutoDeleteArchivedEnabled);

  React.useEffect(() => {
    if (!enabled || !automaticEnabled) return;
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
  }, [enabled, automaticEnabled, github, git]);
};
