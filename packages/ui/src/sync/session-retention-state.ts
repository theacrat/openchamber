const restoredAtBySession = new Map<string, number>();

export const markSessionRestored = (sessionId: string, restoredAt = Date.now()): void => {
  restoredAtBySession.set(sessionId, restoredAt);
};

export const getSessionRestoredAt = (sessionId: string): number => restoredAtBySession.get(sessionId) ?? 0;

export const getPersistedSessionRestoredAt = (session: { metadata?: unknown }): number => {
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 0;
  const openchamber = (metadata as { openchamber?: unknown }).openchamber;
  if (!openchamber || typeof openchamber !== 'object' || Array.isArray(openchamber)) return 0;
  const restoredAt = (openchamber as { sessionRetentionRestoredAt?: unknown }).sessionRetentionRestoredAt;
  return typeof restoredAt === 'number' && Number.isFinite(restoredAt) ? restoredAt : 0;
};

export const recordDeliveryRestoredAt = (sessionId: string, restoredAt = Date.now()): void => {
  markSessionRestored(sessionId, restoredAt);
};
