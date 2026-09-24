const restoredAtBySession = new Map<string, number>();

export const markSessionRestored = (sessionId: string, restoredAt = Date.now()): void => {
  restoredAtBySession.set(sessionId, restoredAt);
};

export const getSessionRestoredAt = (sessionId: string): number => restoredAtBySession.get(sessionId) ?? 0;
