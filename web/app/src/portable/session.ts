import type { PortableCookie, PortableSession } from '@bitchord/shared/bridge';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * The session file a phone imports (extension/lib/portableSession.ts).
 *
 * It is a credential, so it lives in IndexedDB only: never localStorage,
 * never a query cache, never the log. It is also not in the query cache's
 * reach: the hooks below hold the account's name and picture separately, so
 * the settings screens can show who is signed in without ever loading the
 * cookies into React state.
 */

export const SESSION_FORMAT = 'bitchord-session';

interface PortableDB extends DBSchema {
  'youtube-session': { key: 'current'; value: PortableSession };
}

let dbPromise: Promise<IDBPDatabase<PortableDB>> | null = null;

/**
 * Opening can stall rather than fail: another tab mid-`deleteDatabase`, or a
 * browser whose IndexedDB is wedged. Every reader must settle either way, or
 * the music layer waits on the auth read forever (getMusicClient awaits it),
 * so a stalled open counts as "no session" after this long.
 */
const OPEN_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), OPEN_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

function db(): Promise<IDBPDatabase<PortableDB>> {
  dbPromise ??= openDB<PortableDB>('bitchord-portable', 1, {
    upgrade(database) {
      database.createObjectStore('youtube-session');
    },
    blocked() {
      // Another tab holds an older connection: give up rather than wait.
      dbPromise = null;
    },
  });
  return dbPromise;
}

/** The database, or null when it can't be opened (private mode, a stalled open). */
async function dbOrNull(): Promise<IDBPDatabase<PortableDB> | null> {
  try {
    return await withTimeout(db(), null);
  } catch {
    dbPromise = null;
    return null;
  }
}

/** Why an imported file was refused, in words the settings screen can show. */
export class SessionFileError extends Error {
  override readonly name = 'SessionFileError';
}

function isCookie(value: unknown): value is PortableCookie {
  const c = value as Partial<PortableCookie> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.name === 'string' &&
    typeof c.value === 'string' &&
    typeof c.domain === 'string' &&
    typeof c.path === 'string' &&
    typeof c.secure === 'boolean'
  );
}

/**
 * Reads a session file the user picked. The shape is checked strictly: a
 * half-valid file would otherwise be stored and fail much later, mid-request,
 * far from the mistake.
 */
export function parseSession(text: string): PortableSession {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SessionFileError('That file isn’t JSON. Choose the session file the BitChord extension exported.');
  }
  const s = value as Partial<PortableSession> | null;
  if (s?.format !== SESSION_FORMAT || s.version !== 1) {
    throw new SessionFileError('That isn’t a BitChord session file (or it’s from a newer version).');
  }
  const youtube = s.youtube as Partial<PortableSession['youtube']> | undefined;
  if (!youtube || typeof youtube.sapisid !== 'string' || !youtube.sapisid) {
    throw new SessionFileError('The session file has no signing cookie (SAPISID). Export it again from the extension.');
  }
  if (typeof youtube.authUser !== 'string' || !Array.isArray(youtube.cookies) || !youtube.cookies.every(isCookie)) {
    throw new SessionFileError('The session file’s cookies are malformed. Export it again from the extension.');
  }
  // The signature is taken over SAPISID; keeping the two apart lets a file be
  // updated without re-reading the cookie list.
  if (!youtube.cookies.some((c) => c.value === youtube.sapisid)) {
    throw new SessionFileError('The session file’s signing cookie doesn’t match its cookies. Export it again from the extension.');
  }
  return {
    format: SESSION_FORMAT,
    version: 1,
    exportedAt: typeof s.exportedAt === 'number' ? s.exportedAt : Date.now(),
    youtube: {
      cookies: youtube.cookies,
      sapisid: youtube.sapisid,
      authUser: youtube.authUser,
      account: youtube.account ?? null,
    },
  };
}

/** Stores an imported session, replacing any earlier one. */
export async function saveSession(session: PortableSession): Promise<void> {
  const database = (await dbOrNull()) ?? (await db());
  await database.put('youtube-session', session, 'current');
}

/** The stored session, or null; the one reader of the credential. */
export async function loadSession(): Promise<PortableSession | null> {
  try {
    const database = await dbOrNull();
    return (await database?.get('youtube-session', 'current')) ?? null;
  } catch {
    // A private window without IndexedDB: treat it as no session.
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const database = await dbOrNull();
  await database?.delete('youtube-session', 'current');
}

/** Whether a session is stored, without loading it. */
export async function hasSession(): Promise<boolean> {
  try {
    const database = await dbOrNull();
    return ((await database?.count('youtube-session')) ?? 0) > 0;
  } catch {
    return false;
  }
}

/** A stored session's cookies as a Cookie header, for a request to [url]. */
export function cookieHeaderFor(session: PortableSession, url: string): string {
  const host = new URL(url).hostname;
  const now = Date.now();
  return session.youtube.cookies
    .filter((c) => !c.expirationDate || c.expirationDate > now)
    .filter((c) => {
      // ".youtube.com" and "music.youtube.com" both match music.youtube.com,
      // and a leading dot is what browsers store for a domain cookie.
      const domain = c.domain.replace(/^\./, '');
      return host === domain || host.endsWith(`.${domain}`);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}
