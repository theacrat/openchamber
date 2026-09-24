import React from 'react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsInset,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useI18n, type I18nKey } from '@/lib/i18n';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_ACTION_OPTIONS: Array<{ value: 'archive' | 'delete'; labelKey: I18nKey }> = [
  { value: 'archive', labelKey: 'settings.openchamber.sessionRetention.action.archive' },
  { value: 'delete', labelKey: 'settings.openchamber.sessionRetention.action.delete' },
];

export const SessionRetentionSettings: React.FC = () => {
  const { t } = useI18n();
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const onlyArchived = useUIStore((state) => state.sessionRetentionOnlyArchived);
  const setAutoDeleteEnabled = useUIStore((state) => state.setAutoDeleteEnabled);
  const setAutoDeleteAfterDays = useUIStore((state) => state.setAutoDeleteAfterDays);
  const setSessionRetentionAction = useUIStore((state) => state.setSessionRetentionAction);
  const setOnlyArchived = useUIStore((state) => state.setSessionRetentionOnlyArchived);
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

  const { candidates, isRunning, runCleanup, action, status } = useSessionAutoCleanup({ autoRun: false });
  const pendingCount = candidates.length;

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup({ force: true }).catch(() => {
      toast.error(t('sessions.sidebar.group.empty.loadFailed'));
      return null;
    });
    if (!result || (result.skippedReason && result.skippedReason !== 'no-candidates')) return;

    if (result.completedIds.length === 0 && result.failedIds.length === 0) {
      toast.message(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.noneEligibleArchive')
          : t('settings.openchamber.sessionRetention.toast.noneEligibleDelete')
      );
      return;
    }
    if (result.completedIds.length > 0) {
      toast.success(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.archivedCount', { count: result.completedIds.length })
          : t('settings.openchamber.sessionRetention.toast.deletedCount', { count: result.completedIds.length })
      );
    }
    if (result.failedIds.length > 0) {
      toast.error(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.failedArchiveCount', { count: result.failedIds.length })
          : t('settings.openchamber.sessionRetention.toast.failedDeleteCount', { count: result.failedIds.length })
      );
    }
  }, [runCleanup, t]);

  return (
    <SettingsSection
      title={t('settings.openchamber.sessionRetention.title')}
      description={t('settings.openchamber.sessionRetention.foregroundBoundary')}
      info={t(onlyArchived
        ? 'settings.openchamber.sessionRetention.archivedTooltip'
        : 'settings.openchamber.sessionRetention.tooltip')}
    >
      <SettingsCheckboxRow
        settingsItem="sessions.auto-cleanup"
        checked={autoDeleteEnabled}
        onChange={setAutoDeleteEnabled}
        label={t('settings.openchamber.sessionRetention.field.enableAutoCleanup')}
        ariaLabel={t('settings.openchamber.sessionRetention.field.enableAutoCleanupAria')}
      />

      <SettingsCheckboxRow settingsItem="sessions.auto-archive" checked={autoArchiveEnabled} onChange={setAutoArchiveEnabled}
        label={t('settings.openchamber.sessionRetention.field.autoArchive')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoArchive')} />
      <SettingsFieldRow settingsItem="sessions.auto-archive-period" label={t('settings.openchamber.sessionRetention.field.autoArchivePeriod')}>
        <NumberInput value={autoArchiveAfterDays} onValueChange={setAutoArchiveAfterDays} min={MIN_DAYS} max={MAX_DAYS} step={1}
          aria-label={t('settings.openchamber.sessionRetention.field.autoArchivePeriod')} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
        <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.sessionRetention.field.days')}</span>
      </SettingsFieldRow>
      <SettingsCheckboxRow settingsItem="sessions.auto-archive-on-merge" checked={autoArchiveOnMerge} onChange={setAutoArchiveOnMerge}
        label={t('settings.openchamber.sessionRetention.field.autoArchiveOnMerge')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoArchiveOnMerge')} />
      <SettingsCheckboxRow settingsItem="sessions.auto-unarchive-on-prompt" checked={autoUnarchiveOnPrompt} onChange={setAutoUnarchiveOnPrompt}
        label={t('settings.openchamber.sessionRetention.field.autoUnarchiveOnPrompt')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoUnarchiveOnPrompt')} />
      <SettingsCheckboxRow settingsItem="sessions.retention-exclude-pinned" checked={excludePinned} onChange={setExcludePinned}
        label={t('settings.openchamber.sessionRetention.field.excludePinned')} ariaLabel={t('settings.openchamber.sessionRetention.field.excludePinned')} />
      <SettingsCheckboxRow settingsItem="sessions.auto-delete-archived" checked={autoDeleteArchivedEnabled} onChange={setAutoDeleteArchivedEnabled}
        label={t('settings.openchamber.sessionRetention.field.autoDeleteArchived')} ariaLabel={t('settings.openchamber.sessionRetention.field.autoDeleteArchived')} />
      <SettingsFieldRow settingsItem="sessions.auto-delete-archived-period" label={t('settings.openchamber.sessionRetention.field.autoDeleteArchivedPeriod')}>
        <NumberInput value={autoDeleteArchivedAfterDays} onValueChange={setAutoDeleteArchivedAfterDays} min={MIN_DAYS} max={MAX_DAYS} step={1}
          aria-label={t('settings.openchamber.sessionRetention.field.autoDeleteArchivedPeriod')} className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')} />
        <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.sessionRetention.field.days')}</span>
      </SettingsFieldRow>

      <SettingsInset className="space-y-0">
        <SettingsCheckboxRow
          settingsItem="sessions.retention-only-archived"
          checked={onlyArchived}
          onChange={setOnlyArchived}
          disabled={isRunning}
          label={t('settings.openchamber.sessionRetention.field.onlyArchived')}
          ariaLabel={t('settings.openchamber.sessionRetention.field.onlyArchived')}
          info={t('settings.openchamber.sessionRetention.field.onlyArchivedDescription')}
        />
        <SettingsFieldRow
          settingsItem="sessions.retention-period"
          label={t('settings.openchamber.sessionRetention.field.retentionPeriod')}
        >
          <NumberInput
            value={autoDeleteAfterDays}
            onValueChange={setAutoDeleteAfterDays}
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            aria-label={t('settings.openchamber.sessionRetention.field.retentionPeriodAria')}
            className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
          />
          <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.sessionRetention.field.days')}</span>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setAutoDeleteAfterDays(DEFAULT_RETENTION_DAYS)}
            disabled={autoDeleteAfterDays === DEFAULT_RETENTION_DAYS}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={t('settings.openchamber.sessionRetention.actions.resetRetentionAria')}
            title={t('settings.common.actions.reset')}
          >
            <Icon name="restart" className="h-3.5 w-3.5" />
          </Button>
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="sessions.retention-action"
          label={t('settings.openchamber.sessionRetention.field.whenSessionsExpire')}
        >
          <SettingsChipGroup
            value={action}
            onChange={setSessionRetentionAction}
            options={RETENTION_ACTION_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
              disabled: onlyArchived && option.value === 'archive',
            }))}
          />
        </SettingsFieldRow>
      </SettingsInset>

      <div className="mt-1 py-1.5 space-y-1">
        <SettingsFieldRow
          label={t('settings.openchamber.sessionRetention.manualCleanup.title')}
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleRunCleanup}
            disabled={isRunning}
            className="!font-normal"
          >
            {isRunning ? t('settings.openchamber.sessionRetention.actions.cleaningUp') : t('settings.openchamber.sessionRetention.actions.runCleanupNow')}
          </Button>
        </SettingsFieldRow>
        <p className="typography-meta text-muted-foreground">
          {status === 'error'
            ? t('sessions.sidebar.group.empty.loadFailed')
            : status !== 'ready'
            ? t('sessions.sidebar.group.empty.loadingSessions')
            : action === 'archive'
            ? t('settings.openchamber.sessionRetention.manualCleanup.eligibleArchiveNow', { count: pendingCount })
            : t('settings.openchamber.sessionRetention.manualCleanup.eligibleDeleteNow', { count: pendingCount })}
        </p>
      </div>
    </SettingsSection>
  );
};
