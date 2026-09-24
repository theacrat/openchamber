import React from 'react';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { deleteAllArchivedSessions, previewArchivedDeletion, useSessionRetentionRunStore, type ArchivedDeletionPlan, type DeleteAllArchivedResult } from '@/sync/session-retention';
import { useI18n } from '@/lib/i18n';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
type DeletionDialog =
  | { kind: 'closed' | 'loading' | 'error' | 'running' }
  | { kind: 'ready'; plan: ArchivedDeletionPlan }
  | { kind: 'result'; result: DeleteAllArchivedResult; plan: ArchivedDeletionPlan };
export const SessionRetentionSettings: React.FC = () => {
  const { t } = useI18n();
  const autoArchiveEnabled = useUIStore((state) => state.sessionAutoArchiveEnabled);
  const autoArchiveAfterDays = useUIStore((state) => state.sessionAutoArchiveAfterDays);
  const autoArchiveOnMerge = useUIStore((state) => state.sessionAutoArchiveOnMerge);
  const autoUnarchiveOnPrompt = useUIStore((state) => state.sessionAutoUnarchiveOnPrompt);
  const excludePinned = useUIStore((state) => state.sessionRetentionExcludePinned);
  const autoDeleteArchivedEnabled = useUIStore((state) => state.sessionAutoDeleteArchivedEnabled);
  const autoDeleteArchivedAfterDays = useUIStore((state) => state.sessionAutoDeleteArchivedAfterDays);
  const setAutoArchiveEnabled = useUIStore((state) => state.setSessionAutoArchiveEnabled);
  const setAutoArchiveAfterDays = useUIStore((state) => state.setSessionAutoArchiveAfterDays);
  const setAutoArchiveOnMerge = useUIStore((state) => state.setSessionAutoArchiveOnMerge);
  const setAutoUnarchiveOnPrompt = useUIStore((state) => state.setSessionAutoUnarchiveOnPrompt);
  const setExcludePinned = useUIStore((state) => state.setSessionRetentionExcludePinned);
  const setAutoDeleteArchivedEnabled = useUIStore((state) => state.setSessionAutoDeleteArchivedEnabled);
  const setAutoDeleteArchivedAfterDays = useUIStore((state) => state.setSessionAutoDeleteArchivedAfterDays);
  const [dialog, setDialog] = React.useState<DeletionDialog>({ kind: 'closed' });
  const isRunning = useSessionRetentionRunStore((state) => state.isRunning);
  const request = React.useRef(0);
  React.useEffect(() => () => { request.current += 1; }, []);
  const openDeleteAll = async () => {
    const revision = ++request.current;
    setDialog({ kind: 'loading' });
    const preview = await previewArchivedDeletion();
    if (request.current !== revision) return;
    setDialog(preview.kind === 'ready' ? { kind: 'ready', plan: preview.plan } : { kind: 'error' });
  };
  const runDeleteAll = async () => {
    if (dialog.kind !== 'ready') return;
    const plan = dialog.plan;
    setDialog({ kind: 'running' });
    const revision = ++request.current;
    const result = await deleteAllArchivedSessions(plan);
    if (request.current === revision) setDialog({ kind: 'result', result, plan });
  };
  const closeDeleteAll = () => {
    if (dialog.kind === 'running') return;
    request.current += 1;
    setDialog({ kind: 'closed' });
  };
  useSessionAutoCleanup();

  return (
    <SettingsSection
      title={t('settings.openchamber.sessionRetention.title')}
      description={t('settings.openchamber.sessionRetention.foregroundBoundary')}
      info={t('settings.openchamber.sessionRetention.tooltip')}
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <div className="space-y-4">
          <SettingsCheckboxRow settingsItem="sessions.auto-archive" checked={autoArchiveEnabled} onChange={setAutoArchiveEnabled}
            label={t('settings.openchamber.sessionRetention.field.autoArchive')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoArchive')} />
          <SettingsFieldRow settingsItem="sessions.auto-archive-period" label={t('settings.openchamber.sessionRetention.field.autoArchivePeriod')}>
            <NumberInput value={autoArchiveAfterDays} onValueChange={setAutoArchiveAfterDays} min={MIN_DAYS} max={MAX_DAYS} step={1}
              aria-label={t('settings.openchamber.sessionRetention.field.autoArchivePeriod')} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
            <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.sessionRetention.field.days')}</span>
          </SettingsFieldRow>
        </div>
        <div className="space-y-4">
          <SettingsCheckboxRow settingsItem="sessions.auto-archive-on-merge" checked={autoArchiveOnMerge} onChange={setAutoArchiveOnMerge}
            label={t('settings.openchamber.sessionRetention.field.autoArchiveOnMerge')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoArchiveOnMerge')} />
          <SettingsCheckboxRow settingsItem="sessions.auto-unarchive-on-prompt" checked={autoUnarchiveOnPrompt} onChange={setAutoUnarchiveOnPrompt}
            label={t('settings.openchamber.sessionRetention.field.autoUnarchiveOnPrompt')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoUnarchiveOnPrompt')} />
        </div>
        <div className="space-y-4">
          <SettingsCheckboxRow settingsItem="sessions.retention-exclude-pinned" checked={excludePinned} onChange={setExcludePinned}
            label={t('settings.openchamber.sessionRetention.field.excludePinned')} ariaLabel={t('settings.openchamber.sessionRetention.field.excludePinned')} />
          <SettingsCheckboxRow settingsItem="sessions.auto-delete-archived" checked={autoDeleteArchivedEnabled} onChange={setAutoDeleteArchivedEnabled}
            label={t('settings.openchamber.sessionRetention.field.autoDeleteArchived')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoDeleteArchived')} />
          <SettingsFieldRow settingsItem="sessions.auto-delete-archived-period" label={t('settings.openchamber.sessionRetention.field.autoDeleteArchivedPeriod')}>
            <NumberInput value={autoDeleteArchivedAfterDays} onValueChange={setAutoDeleteArchivedAfterDays} min={MIN_DAYS} max={MAX_DAYS} step={1}
              aria-label={t('settings.openchamber.sessionRetention.field.autoDeleteArchivedPeriod')} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
            <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.sessionRetention.field.days')}</span>
          </SettingsFieldRow>
        </div>
        <SettingsFieldRow
          settingsItem="sessions.delete-all-archived"
          label={t('settings.openchamber.sessionRetention.deleteAll.title')}
          info={t('settings.openchamber.sessionRetention.deleteAll.exclusions')}
        >
          <Button type="button" size="sm" variant="destructive" disabled={isRunning} onClick={() => void openDeleteAll()}>
            {t('settings.common.actions.delete')}
          </Button>
        </SettingsFieldRow>
      </div>
      <Dialog open={dialog.kind !== 'closed'} onOpenChange={(open) => { if (!open) closeDeleteAll(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.openchamber.sessionRetention.deleteAll.title')}</DialogTitle>
            <DialogDescription>
              {dialog.kind === 'loading' || dialog.kind === 'running'
                ? t('settings.openchamber.sessionRetention.deleteAll.working')
                : dialog.kind === 'ready'
                  ? t('settings.openchamber.sessionRetention.deleteAll.confirm', { count: dialog.plan.targets.length, protected: dialog.plan.protectedCount })
                  : dialog.kind === 'result'
                    ? t('settings.openchamber.sessionRetention.deleteAll.result', { deleted: dialog.result.deletedIds.length,
                      remaining: dialog.plan.targets.length - dialog.result.deletedIds.length,
                      failed: dialog.result.failedIds.length })
                    : t('settings.openchamber.sessionRetention.deleteAll.error')}
            </DialogDescription>
            <DialogDescription>{t('settings.openchamber.sessionRetention.deleteAll.exclusions')}</DialogDescription>
            {dialog.kind === 'result' && dialog.result.kind !== 'complete' ? <DialogDescription>{t('settings.openchamber.sessionRetention.deleteAll.error')}</DialogDescription> : null}
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={dialog.kind === 'running'} onClick={closeDeleteAll}>{t('settings.common.actions.cancel')}</Button>
            {dialog.kind === 'ready' ? <Button size="sm" variant="destructive" disabled={isRunning || dialog.plan.targets.length === 0} onClick={() => void runDeleteAll()}>{t('settings.common.actions.delete')}</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
