import React from 'react';
import { NumberInput } from '@/components/ui/number-input';
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
import { useI18n } from '@/lib/i18n';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
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
      </div>
    </SettingsSection>
  );
};
