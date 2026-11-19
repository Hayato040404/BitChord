import type { YtAuthState } from '@bitchord/shared/bridge';
import { config } from '@/config';
import { cookieHeaderFor, loadSession, saveSession } from './session';
import type { PortableSession } from '@bitchord/shared/bridge';

/**
 * The relay's page side (shared/src/relay.ts): YouTube requests without an
 * extension. On Cloudflare Pages the relay is the site's own `/api/yt` and
 * `/api/media`; in development the Vite server answers the same paths. A
 * self-hosted relay can be named with VITE_RELAY_BASE_URL.
 *
 * The session (imported from the desktop extension's file) is read here and
 * nowhere else. Its cookies are attached per request; the SAPISIDHASH is
 * computed in the page, as the extension computes it, so the relay never
 * needs to know the secret.
 */

export const relayBase = (config.relayBaseUrl || '').replace(/\/$/, '');

/**
 * The relay endpoint's absolute URL for [path], on this origin unless configured elsewhere.
 *
 * Same-origin means the origin's root, never the site's base: Cloudflare
 * Pages serves the Function at `/api/*` and the dev/preview servers do the
 * same. A site deployed under a subpath (GitHub Pages) names its relay with
 * `VITE_RELAY_BASE_URL` instead, since Pages can't host one.
 */
export function relayUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${relayBase}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Whether the relay sits on another origin (GitHub Pages with a separate
 * relay host). Same-origin media needs no CORS; a remote one does, at least
 * for Web Audio to read the samples (Automix), so the element asks for it.
 */
export function relayIsCrossOrigin(): boolean {
  try {
    return new URL(relayBase || '.', window.location.origin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** Whether the app has a relay at all (it always does on Pages and in dev). */
export async function relayAvailable(): Promise<boolean> {
  try {
    const response = await fetch(relayUrl('/api/yt'), { method: 'OPTIONS' });
    return response.ok || response.status === 204;
  } catch {
    return false;
  }
}

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `SAPISIDHASH <seconds>_<sha1(seconds + " " + secret + " " + origin)>`, as DesktopYouTubeAuth.sapisidHash. */
export async function sapisidHash(secret: string, origin: string): Promise<string> {
  // Web Crypto is secure-contexts only: on a plain-HTTP LAN address a phone
  // has no `crypto.subtle`, and the failure would otherwise read as a generic
  // TypeError. Signed-in requests need HTTPS (or localhost).
  if (!globalThis.crypto?.subtle) {
    throw new Error('Signed-in requests need a secure address (https://). Open this site over HTTPS, or use it signed out.');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${timestamp} ${secret} ${origin}`));
  return `SAPISIDHASH ${timestamp}_${bytesToHex(digest)}`;
}

/** A session, with its signature minted for one request. */
async function signed(session: PortableSession, origin: string): Promise<Headers> {
  const headers = new Headers();
  headers.set('x-bitchord-cookie', cookieHeaderFor(session, `${origin}/`));
  headers.set('authorization', await sapisidHash(session.youtube.sapisid ?? '', origin));
  headers.set('x-bitchord-auth-user', session.youtube.authUser);
  return headers;
}

/** Whether a stored session exists and hasn't lapsed. */
export async function storedSession(): Promise<PortableSession | null> {
  const session = await loadSession();
  if (!session) return null;
  const lapsed = session.youtube.cookies.every((c) => c.expirationDate !== undefined && c.expirationDate < Date.now());
  return lapsed ? null : session;
}

/**
 * Sends an InnerTube call through the relay as the stored session, when there
 * is one. Returns the raw Response so youtubei.js can read it like any other.
 */
export async function relayYtFetch(input: RequestInfo | URL, init?: RequestInit, session?: PortableSession | null): Promise<Response> {
  const target = new URL(input instanceof Request ? input.url : input.toString());
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const source = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  let body: ArrayBuffer | undefined;
  if (init?.body != null && method !== 'GET' && method !== 'HEAD') {
    body = typeof init.body === 'string' ? new TextEncoder().encode(init.body).buffer : await new Response(init.body).arrayBuffer();
  } else if (input instanceof Request && method !== 'GET' && method !== 'HEAD') {
    body = await input.arrayBuffer();
  }

  const headers = session
    ? await signed(session, `https://${target.hostname === 'youtube.com' ? 'www.youtube.com' : target.hostname}`)
    : new Headers();
  headers.set('content-type', source.get('content-type') ?? 'text/plain;charset=UTF-8');
  const language = source.get('accept-language');
  if (language) headers.set('accept-language', language);

  const response = await fetch(relayUrl('/api/yt', { url: target.toString() }), {
    method,
    headers,
    ...(body && { body }),
    signal: init?.signal ?? (input instanceof Request ? input.signal : null),
  });
  return response;
}

/**
 * Any other YouTube read through the relay as the page's anonymous reader:
 * the session bootstrap (`/sw.js_data`), the player script and `iframe_api`.
 * Different from `relayYtFetch` in that no session rides along: these are the
 * calls that build the anonymous YouTube.js instance.
 */
export async function relayPageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(input instanceof Request ? input.url : input.toString());
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers();
  const source = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  source.forEach((value, key) => {
    if (['accept', 'accept-language', 'content-type'].includes(key.toLowerCase())) headers.set(key, value);
  });
  let body: ArrayBuffer | undefined;
  if (init?.body != null && method !== 'GET' && method !== 'HEAD') {
    body = typeof init.body === 'string' ? new TextEncoder().encode(init.body).buffer : await new Response(init.body).arrayBuffer();
  } else if (input instanceof Request && method !== 'GET' && method !== 'HEAD') {
    body = await input.arrayBuffer();
  }
  const response = await fetch(relayUrl('/api/yt', { url: target.toString() }), {
    method,
    headers,
    ...(body && { body }),
    signal: init?.signal ?? (input instanceof Request ? input.signal : null),
  });
  return response;
}

/** A googlevideo URL as one the relay will fetch from the IP it was minted for. */
export function relayedMediaUrl(mediaUrl: string): string {
  return relayUrl('/api/media', { url: mediaUrl });
}

/** The account's InnerTube identity, as the extension reports it (for the UI). */
export async function sessionAuthState(): Promise<YtAuthState> {
  const session = await storedSession();
  if (!session) {
    return { browserSignedIn: false, connected: false, signedIn: false, accounts: [], active: null, problem: null };
  }
  const account = session.youtube.account;
  const channel: YtAuthState['active'] = {
    id: `${session.youtube.authUser}:own`,
    name: account?.name ?? 'YouTube Music',
    handle: account?.handle ?? null,
    avatarUrl: account?.avatarUrl ?? null,
    brand: false,
    authUser: session.youtube.authUser,
  };
  return {
    browserSignedIn: true,
    connected: true,
    signedIn: true,
    accounts: [
      {
        authUser: session.youtube.authUser,
        name: account?.name ?? 'YouTube Music',
        email: null,
        avatarUrl: account?.avatarUrl ?? null,
        channels: [channel],
      },
    ],
    active: channel,
    problem: null,
  };
}

export { saveSession };
