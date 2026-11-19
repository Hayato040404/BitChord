import type { PortableAccount } from '@bitchord/shared/bridge';
import { useEffect, useState } from 'react';
import { forgetYtAuth } from '@/extension/useYtAuth';
import { clearSession, loadSession, parseSession, saveSession } from './session';

/**
 * The stored session file, for the settings screens. Only the account's name
 * and picture are ever put in React state; the cookies stay in IndexedDB
 * (portable/session.ts), which is the one place that reads them.
 */

export type SessionStatus =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'present'; account: PortableAccount | null; exportedAt: number };

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Reads the status once; the one reader used here, so no cookies reach state. */
async function read(): Promise<SessionStatus> {
  const session = await loadSession();
  if (!session) return { state: 'none' };
  return { state: 'present', account: session.youtube.account, exportedAt: session.exportedAt };
}

export function usePortableSession(): SessionStatus {
  const [status, setStatus] = useState<SessionStatus>({ state: 'checking' });
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void read().then((next) => {
        if (alive) setStatus(next);
      });
    };
    refresh();
    listeners.add(refresh);
    return () => {
      alive = false;
      listeners.delete(refresh);
    };
  }, []);
  return status;
}

/**
 * Stores a file the user picked and makes the app read it: the auth state is
 * re-read and every browse response cached as the previous identity is
 * dropped, so the library appears without a reload.
 */
export async function importSessionFile(file: File): Promise<void> {
  const session = parseSession(await file.text());
  await saveSession(session);
  forgetYtAuth();
  notify();
}

/** Forgets the imported session. The browser's own YouTube session is untouched (there is none to touch without the extension). */
export async function removeSessionFile(): Promise<void> {
  await clearSession();
  forgetYtAuth();
  notify();
}
