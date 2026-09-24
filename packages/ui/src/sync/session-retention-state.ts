import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';

const restoredAtBySession = new Map<string, number>();
const restoreKey = (sessionId: string): string => JSON.stringify([getRuntimeKey(), sessionId]);
const restoreMetadata = z.object({
  openchamber: z.object({ sessionRetentionRestoredAt: z.number().finite().nonnegative() }),
});

export const markSessionRestored = (sessionId: string, restoredAt = Date.now()): void => {
  restoredAtBySession.set(restoreKey(sessionId), restoredAt);
};

export const getSessionRestoredAt = (sessionId: string): number => restoredAtBySession.get(restoreKey(sessionId)) ?? 0;

export const getPersistedSessionRestoredAt = (session: Pick<Session, 'metadata'>): number => {
  const parsed = restoreMetadata.safeParse(session.metadata);
  return parsed.success ? parsed.data.openchamber.sessionRetentionRestoredAt : 0;
};
