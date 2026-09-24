/**
 * OpenChamber session state for the VS Code runtime: archive flags and
 * per-session metadata.
 *
 * OpenCode 2.x has no archive route, so archive flags are OpenChamber's own. The
 * OpenChamber server keeps them in a JSON file beside its OpenCode instance
 * (`packages/web/server/lib/openchamber-sessions/`); the extension host has no
 * server process, so it keeps the same file itself, in the shared OpenChamber
 * config directory, which is also the web server's default data directory: a
 * session archived from VS Code stays archived in the desktop app on the same
 * machine and the other way round.
 *
 * Metadata lives on the OpenCode session record (`PATCH /api/session/{id}`,
 * OpenCode 2.0.15+). Before that it lived in `sessions-metadata.json` in the
 * same directory. An entry still in that file is the newest metadata its
 * session has: reads lay it over OpenCode's record, and the session's next
 * write pushes the result to OpenCode and drops the entry. The web server
 * sweeps the rest.
 *
 * Two processes may write these files, so nothing is cached between calls:
 * every read parses the file and every write re-reads it first, then replaces
 * it atomically. The files are a few kilobytes, and the reads sit behind
 * session list requests, not on a hot path.
 *
 * Metadata writes are a JSON Merge Patch (RFC 7386): nested objects merge key
 * by key and `null` deletes. OpenCode replaces the whole object on PATCH, so
 * the merge happens here, and two features writing into the same `openchamber`
 * namespace (goal mode, session assist, pinned context, review links) do not
 * erase each other.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';
const METADATA_FILE_NAME = 'sessions-metadata.json';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
/** Free-form JSON attached to a session; the same shape the shared UI's `Metadata` has. */
export type SessionMetadata = JsonObject;

/**
 * Archive state per session: a number archives, `null` is an explicit
 * unarchive that drops the stamp OpenCode still carries (sessions migrated
 * from v1), and a session that is absent keeps whatever OpenCode says.
 */
type ArchivedSessions = Record<string, number | null>;
type StoredSessionMetadata = Record<string, SessionMetadata>;

export type SessionStateFs = {
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  writeFile: (filePath: string, data: string, encoding: 'utf8') => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<string | undefined>;
};

/** One session's metadata on OpenCode. `read` resolves `null` for a session OpenCode does not know. */
export type SessionMetadataOnOpenCode = {
  read: (sessionID: string) => Promise<SessionMetadata | null>;
  write: (sessionID: string, metadata: SessionMetadata) => Promise<void>;
  readSession: (sessionID: string) => Promise<{ time?: { archived?: number } } | null>;
};

type SessionStateStoreOptions = {
  dataDir: string;
  fsPromises?: SessionStateFs;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// JSON boundary: every byte from disk or from a proxied response enters as a
// `JsonValue` here, and the guards below are the only narrowing in the module.
// ---------------------------------------------------------------------------

/** Parses text into a JSON value; `null` when it is not JSON. */
export const parseJson = (text: string): JsonValue | null => {
  try {
    // SAFETY: JSON.parse can only produce strings, numbers, booleans, null,
    // arrays, and plain objects, which is exactly the JsonValue union.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';

const isTimestamp = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A session id as the bridge or a file carries it: a non-empty trimmed string, else `null`. */
export const asSessionId = (value: JsonValue | undefined): string | null => {
  if (!isJsonString(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const asTimestamp = (value: JsonValue | undefined): number | null => (isTimestamp(value) ? value : null);

export const asSessionIdList = (value: JsonValue | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const id = asSessionId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

export const asSessionMetadata = (value: JsonValue | undefined): SessionMetadata | null =>
  isJsonObject(value) ? value : null;

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
export const mergeMetadataPatch = (current: SessionMetadata | undefined, patch: SessionMetadata): SessionMetadata => {
  const base: SessionMetadata = current ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    const previous = base[key];
    base[key] = isJsonObject(value) ? mergeMetadataPatch(isJsonObject(previous) ? previous : undefined, value) : value;
  }
  return base;
};

/** The shared OpenChamber config directory, the web server's default data dir. */
export const getOpenChamberDataDir = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const isMissingFileError = (error: Error): boolean => 'code' in error && error.code === 'ENOENT';

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createSessionStateStore = ({
  dataDir,
  fsPromises = fs.promises,
  now = Date.now,
}: SessionStateStoreOptions) => {
  const archivePath = path.join(dataDir, ARCHIVE_FILE_NAME);
  const metadataPath = path.join(dataDir, METADATA_FILE_NAME);
  let writeChain: Promise<unknown> = Promise.resolve();
  let mutationChain: Promise<void> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(operation, operation);
    mutationChain = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * Parses one state file. A missing file is the normal first run and reads
   * as empty; malformed contents and I/O failures are unknown, not empty.
   */
  const readJsonObjectFile = async (filePath: string): Promise<JsonObject | null> => {
    let raw: string;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && isMissingFileError(error)) return {};
      console.warn(`[openchamber-sessions] could not read ${path.basename(filePath)}:`, describeError(error));
      return null;
    }
    const parsed = parseJson(raw);
    if (isJsonObject(parsed)) return parsed;
    console.warn(`[openchamber-sessions] ${path.basename(filePath)} is not a JSON object`);
    return null;
  };

  const writeJsonObjectFile = (filePath: string, value: JsonObject): Promise<void> => {
    const write = async () => {
      await fsPromises.mkdir(dataDir, { recursive: true });
      // Temp file in the same directory so the rename is atomic on one device.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify(value), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    };
    const next = writeChain.then(write, write);
    writeChain = next.catch(() => undefined);
    return next;
  };

  const readArchived = async (): Promise<ArchivedSessions | null> => {
    const parsed = await readJsonObjectFile(archivePath);
    if (!parsed) return null;
    const result: ArchivedSessions = {};
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asSessionId(sessionID);
      if (!id) return null;
      if (value === null) result[id] = null;
      else if (isTimestamp(value)) result[id] = value;
      else return null;
    }
    return result;
  };

  const readMetadata = async (): Promise<StoredSessionMetadata | null> => {
    const parsed = await readJsonObjectFile(metadataPath);
    if (!parsed) return null;
    const result: StoredSessionMetadata = {};
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asSessionId(sessionID);
      if (id && isJsonObject(value)) result[id] = value;
    }
    return result;
  };

  /** Sets or clears the archive flag for a batch; `null` clears. */
  const applyArchive = async (ids: string[], archivedAt: number | null) => {
    const targets = asSessionIdList(ids);
    if (targets.length === 0) return { applied: [] as string[], failedIds: [] as string[] };
    const current = await readArchived();
    if (!current) return { applied: [] as string[], failedIds: targets };
    const next: ArchivedSessions = { ...current };
    for (const id of targets) next[id] = archivedAt;
    try {
      await writeJsonObjectFile(archivePath, next);
    } catch (error) {
      console.warn('[openchamber-sessions] failed to persist archive state:', describeError(error));
      return { applied: [] as string[], failedIds: targets };
    }
    return { applied: targets, failedIds: [] as string[] };
  };

  const setMetadata = async (sessionID: string, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
    const stored = await readMetadata();
    if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
    const upstream = await openCode.read(sessionID);
    if (!upstream) throw new Error(`session ${sessionID} was not found`);
    const legacy = stored[sessionID];
    const merged = mergeMetadataPatch(legacy ? mergeMetadataPatch(upstream, legacy) : upstream, patch);
    await openCode.write(sessionID, merged);
    if (legacy) {
      const latest = await readMetadata();
      if (!latest) throw new Error('session metadata is unavailable: its file could not be read');
      if (latest[sessionID]) {
        if (JSON.stringify(latest[sessionID]) !== JSON.stringify(legacy)) {
          throw new Error('Legacy session metadata changed during migration');
        }
        delete latest[sessionID];
        await writeJsonObjectFile(metadataPath, latest);
      }
    }
    return merged;
  };

  const restoreSession = async (sessionID: string, openCode: SessionMetadataOnOpenCode): Promise<boolean> => {
    try {
      const archived = await readArchived();
      if (!archived) return false;
      if (Object.prototype.hasOwnProperty.call(archived, sessionID)) {
        if (archived[sessionID] === null) return true;
      } else {
        const upstream = await openCode.readSession(sessionID);
        if (!upstream) return false;
        if (asTimestamp(upstream.time?.archived) === null) return true;
      }
      await setMetadata(sessionID, { openchamber: { sessionRetentionRestoredAt: now() } }, openCode);
      const result = await applyArchive([sessionID], null);
      return result.applied.includes(sessionID);
    } catch {
      return false;
    }
  };

  return {
    archivePath,
    metadataPath,
    /** `{ [sessionID]: archivedAt }`, or `null` when the file could not be read. */
    readArchived,
    /** `{ [sessionID]: metadata }`, or `null` when the file could not be read. */
    readMetadata,
    archive: (ids: string[], archivedAt: number | null = null) => mutate(async () => {
      const stamp = archivedAt ?? now();
      const { applied, failedIds } = await applyArchive(ids, stamp);
      return { archived: applied.map((id) => ({ id, archivedAt: stamp })), failedIds };
    }),
    unarchive: (ids: string[], openCode: SessionMetadataOnOpenCode) => mutate(async () => {
      const restored: Array<{ id: string; archivedAt: null }> = [];
      const failedIds: string[] = [];
      for (const sessionID of asSessionIdList(ids)) {
        const result = await restoreSession(sessionID, openCode);
        if (result) restored.push({ id: sessionID, archivedAt: null });
        else failedIds.push(sessionID);
      }
      return { restored, failedIds };
    }),
    restoreForDelivery: (sessionID: string, openCode: SessionMetadataOnOpenCode) => mutate(() => restoreSession(sessionID, openCode)),
    /** The session's full metadata: a legacy entry laid over OpenCode's record. `{}` for an unknown session. */
    getMetadata: async (sessionID: string, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      const legacy = stored[sessionID];
      return legacy ? mergeMetadataPatch(upstream ?? {}, legacy) : upstream ?? {};
    },
    /**
     * Applies a merge patch on OpenCode and resolves with the session's full
     * metadata afterwards. A legacy entry is folded in and then dropped from
     * the file, since OpenCode now holds it.
     */
    setMetadata: (sessionID: string, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode) => mutate(() => setMetadata(sessionID, patch, openCode)),
  };
};

export type SessionStateStore = ReturnType<typeof createSessionStateStore>;

/**
 * Folds owned state onto one OpenCode session record: `time.archived` from the
 * archive file (dropped when the file says the session is not archived) and
 * legacy metadata not yet migrated merged over OpenCode's record. A value
 * that is not a session record passes through untouched.
 */
const overlaySessionRecord = (
  value: JsonValue,
  archived: ArchivedSessions | null,
  stored: StoredSessionMetadata | null,
): JsonValue => {
  if (!isJsonObject(value)) return value;
  const id = asSessionId(value.id);
  if (!id) return value;
  let result = value;
  if (archived && Object.prototype.hasOwnProperty.call(archived, id)) {
    const time = isJsonObject(result.time) ? result.time : {};
    const archivedAt = archived[id];
    if (typeof archivedAt === 'number') {
      result = { ...result, time: { ...time, archived: archivedAt } };
    } else if ('archived' in time) {
      const rest = { ...time };
      delete rest.archived;
      result = { ...result, time: rest };
    }
  }
  if (stored) {
    const ours = stored[id];
    if (ours) {
      const theirs = isJsonObject(result.metadata) ? result.metadata : {};
      result = { ...result, metadata: mergeMetadataPatch(theirs, ours) };
    }
  }
  return result;
};

/**
 * Applies `overlaySessionRecord` to a proxied `GET /api/session` list or
 * `GET /api/session/:id` body. Both shapes OpenCode uses are handled: a bare
 * record/array and the `{ data }` envelope. Anything else passes through.
 */
export const overlaySessionResponseBody = (
  body: JsonValue,
  archived: ArchivedSessions | null,
  stored: StoredSessionMetadata | null,
): JsonValue => {
  if (!archived && !stored) return body;
  if (Array.isArray(body)) return body.map((entry) => overlaySessionRecord(entry, archived, stored));
  if (!isJsonObject(body)) return body;
  const data = body.data;
  if (Array.isArray(data)) {
    return { ...body, data: data.map((entry) => overlaySessionRecord(entry, archived, stored)) };
  }
  if (isJsonObject(data)) {
    return { ...body, data: overlaySessionRecord(data, archived, stored) };
  }
  return overlaySessionRecord(body, archived, stored);
};

/** `GET /api/session` (list) and `GET /api/session/:id` (one record) carry session records to overlay. */
export const isSessionRecordPath = (pathname: string): boolean =>
  pathname === '/api/session' || /^\/api\/session\/[^/]+$/.test(pathname);
