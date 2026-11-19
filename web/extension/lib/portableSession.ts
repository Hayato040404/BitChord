import type { PortableCookie, PortableSession, YtAuthState } from '@bitchord/shared/bridge';
import { authState } from './ytAuth';

/**
 * The session file a phone imports (web/app/src/portable/session.ts). The
 * extension reads the browser's own YouTube cookies and writes the ones a
 * signed-in request needs, together with the SAPISID the hash is taken over.
 *
 * This is a credential, and it is written only on the user's explicit action,
 * from the extension's own popup. BitChord's page never receives it: the
 * popup downloads the file itself, so the page can't read it or leak it.
 */

/** The cookies signed-in YouTube requests need; SIDCC and friends rotate constantly and aren't among them. */
const NEEDED = new Set([
  'SAPISID',
  '__Secure-3PAPISID',
  '__Secure-1PAPISID',
  'SID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  'HSID',
  'SSID',
  'APISID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  'LOGIN_INFO',
  'PREF',
  'VISITOR_INFO1_LIVE',
  'YSC',
]);

const MUSIC_ORIGIN = 'https://music.youtube.com';

async function cookiesFor(name: string): Promise<Browser.cookies.Cookie[]> {
  const found = await browser.cookies.getAll({ url: `${MUSIC_ORIGIN}/`, name }).catch(() => []);
  if (found.length) return found;
  // A partitioned or domain-tagged copy still belongs to youtube.com; ask for it directly.
  return browser.cookies.getAll({ domain: '.youtube.com', name }).catch(() => []);
}

/** The signing secret: the first of Google's preferred SAPISID cookies that exists. */
async function sapisid(): Promise<string | null> {
  for (const name of ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID']) {
    const [cookie] = await cookiesFor(name);
    if (cookie?.value) return cookie.value;
  }
  return null;
}

async function neededCookies(): Promise<PortableCookie[]> {
  const out: PortableCookie[] = [];
  const seen = new Set<string>();
  for (const name of NEEDED) {
    for (const cookie of await cookiesFor(name)) {
      if (seen.has(cookie.name) || !cookie.value) continue;
      seen.add(cookie.name);
      out.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.youtube.com',
        path: cookie.path || '/',
        secure: cookie.secure,
        ...(cookie.expirationDate !== undefined && { expirationDate: Math.round(cookie.expirationDate * 1000) }),
      });
    }
  }
  return out;
}

/** Writes the portable session for the account the extension is signed in as. */
export async function exportSession(): Promise<PortableSession> {
  const state: YtAuthState = await authState(true);
  if (!state.signedIn || !state.active) throw new Error('Sign in to YouTube Music in this browser first.');

  const [cookies, secret] = await Promise.all([neededCookies(), sapisid()]);
  if (!secret) throw new Error('This browser holds no YouTube signing cookie (SAPISID).');
  if (!cookies.length) throw new Error('This browser holds no YouTube session cookies.');

  return {
    format: 'bitchord-session',
    version: 1,
    exportedAt: Date.now(),
    youtube: {
      cookies,
      sapisid: secret,
      authUser: state.active.authUser,
      account: {
        name: state.active.name,
        handle: state.active.handle,
        avatarUrl: state.active.avatarUrl,
        authUser: state.active.authUser,
        // `id` is "<authUser>:<pageId>"; a brand channel's pageId is its channel id.
        channelId: state.active.brand ? (state.active.id.split(':')[1] ?? null) : null,
      },
    },
  };
}

/** The file the popup downloads: one JSON object, named for the account and the day. */
export function sessionFileName(session: PortableSession): string {
  const who = (session.youtube.account?.name ?? 'youtube').replace(/[^\w.-]+/g, '-').toLowerCase();
  const day = new Date(session.exportedAt).toISOString().slice(0, 10);
  return `bitchord-session-${who}-${day}.json`;
}
