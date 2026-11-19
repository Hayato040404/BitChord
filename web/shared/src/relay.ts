/**
 * The same-origin relay a phone uses instead of the extension.
 *
 * An iPhone can't install the BitChord extension, so the page can't reach
 * YouTube from the browser itself: music.youtube.com refuses a foreign Origin
 * outright (403, measured 2026-11-14), and googlevideo binds every media URL
 * to the IP that asked for it (`sparams` carries `ip`; a tampered `ip=`
 * answers 403, and a proxy on another address can't fetch it either).
 *
 * So the site's own origin does both. `POST /api/yt` takes the InnerTube
 * request and the session's cookies, calls YouTube from the same machine that
 * will later fetch the audio, and answers with YouTube's JSON. `GET
 * /api/media?url=…` streams the media from that same egress, so the URL's
 * `ip` is the relay's and the ranges arrive unaltered.
 *
 * Cookie forwarding is the one thing that differs from the extension: a
 * browser page can't attach cookies for another site, so the portable session
 * file is sent here as a `Cookie` header. That is why this endpoint must run
 * on the same origin as the app and never log or cache a request.
 *
 * This file has no runtime dependencies: it is the logic shared by the
 * Cloudflare Pages Function, the Vite dev server middleware and the
 * self-hosted Node server.
 */

/** A YouTube session, as the portable file's cookies and signature. */
export interface RelaySession {
  /** `name=value; name=value`, filtered for the target host. */
  cookie: string;
  /** `SAPISIDHASH <seconds>_<sha1(seconds + " " + secret + " " + origin)>`. */
  authorization: string;
  /** `X-Goog-AuthUser`. */
  authUser: string;
}

/** The YouTube hosts the relay will talk to. Anything else is refused. */
const YOUTUBE_HOSTS = new Set(['music.youtube.com', 'www.youtube.com', 'youtube.com', 's.youtube.com']);

/** googlevideo's media hosts: regional subdomains, and the manifest host. */
const MEDIA_HOST = /(^|\.)(googlevideo\.com|googleusercontent\.com|ytimg\.com|ggpht\.com)$/;

/**
 * Lyric providers whose hosts send no CORS headers (or need headers a page
 * may not set). The extension reaches these with optional host permissions;
 * the relay is the same escape hatch for a phone that cannot install it.
 *
 * This list is deliberately closed: `/api/lyrics` is not a general proxy.
 */
const LYRIC_HOSTS = new Set([
  'lrc.red',
  'lyrics-api.binimum.org',
  'lyrics-api.boidu.dev',
  'unison.boidu.dev',
  'lyrics.paxsenix.org',
  'api.paxsenix.org',
  'lyricsplus.prjktla.my.id',
  'lyricsplus.atomix.one',
  'lyricsplus.binimum.org',
  'lyricsplus.prjktla.workers.dev',
  'lyricsplus-seven.vercel.app',
  'lyrics-plus-backend.vercel.app',
  'lrclib.net',
  'mobileservice.kugou.com',
  'lyrics.kugou.com',
  'apic.musixmatch.com',
  'www.musixmatch.com',
  'genius.com',
  'music.apple.com',
  'itunes.apple.com',
  'amp-api.music.apple.com',
]);

/** Headers a client may set on the InnerTube call; everything else is the relay's. */
const FORWARDED_REQUEST_HEADERS = new Set(['content-type', 'accept-language']);

/** Headers worth returning from a media response: ranges and the timing Shaka reads. */
const FORWARDED_MEDIA_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'expires',
  'last-modified',
  'etag',
];

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** HLS playlists need their child URLs rewritten, not just their bytes copied. */
const HLS_CONTENT_TYPE = /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i;

/**
 * Rewrite every URL in an m3u8 to go back through this relay.
 *
 * YouTube's HLS URLs are absolute and signed to the relay's egress IP, so a
 * phone that follows them directly gets a 403. The playlists are text, which
 * makes the fix cheap: point every child (`#EXT-X-MEDIA` renditions, `#EXT-X-MAP`
 * init sections, and segment lines) at `/api/media?url=…`, which is same-origin
 * with the playlist. Relative URLs resolve against the playlist's final URL.
 */
function rewriteHlsPlaylist(text: string, baseUrl: URL): string {
  const relayed = (raw: string): string => {
    let url: URL;
    try {
      url = new URL(raw.trim(), baseUrl);
    } catch {
      return raw;
    }
    if (url.protocol !== 'https:' || !MEDIA_HOST.test(url.hostname)) return raw;
    return `/api/media?url=${encodeURIComponent(url.toString())}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${relayed(uri)}"`);
      }
      return relayed(line);
    })
    .join('\n');
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-bitchord-auth-user, x-bitchord-cookie',
  'access-control-allow-private-network': 'true',
  'access-control-expose-headers': FORWARDED_MEDIA_HEADERS.join(', '),
} as const;

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

function isYouTubeHost(host: string): boolean {
  return YOUTUBE_HOSTS.has(host);
}

function parseTarget(raw: string, allowed: (host: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayError(400, 'That isn’t a URL.');
  }
  if (url.protocol !== 'https:' || !allowed(url.hostname)) {
    throw new RelayError(403, `${url.hostname} isn’t a host this relay serves.`);
  }
  return url;
}

/** The request headers a relayed InnerTube call goes out with: YouTube's own web client's. */
function innertubeHeaders(url: URL, init: Headers, session: RelaySession | null): Headers {
  const headers = new Headers();
  // Only what a client may legitimately choose (the JSON's content type and the
  // language); Origin and the session headers are the relay's to set.
  init.forEach((value, key) => {
    if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('content-type', init.get('content-type') ?? 'text/plain;charset=UTF-8');
  const origin = `https://${url.hostname === 'youtube.com' ? 'www.youtube.com' : url.hostname}`;
  headers.set('origin', origin);
  headers.set('referer', `${origin}/`);
  headers.set('x-origin', origin);
  headers.set('user-agent', CHROME_UA);
  if (!headers.has('accept-language')) headers.set('accept-language', 'en-US,en;q=0.9');
  if (session) {
    headers.set('cookie', session.cookie);
    headers.set('authorization', session.authorization);
    headers.set('x-goog-authuser', session.authUser);
  }
  return headers;
}

/**
 * The session for one call: the client sends the cookies and the signature it
 * computed in two headers, so the relay never holds the SAPISID itself and a
 * request is only signed in when its caller says who it is.
 */
export function sessionFrom(headers: Headers): RelaySession | null {
  const cookie = headers.get('x-bitchord-cookie');
  const authorization = headers.get('authorization');
  const authUser = headers.get('x-bitchord-auth-user');
  if (!cookie || !authorization || !authUser) return null;
  return { cookie, authorization, authUser };
}

/**
 * `POST /api/yt?url=<InnerTube URL>`: the InnerTube call, made from the
 * relay. The body is passed through unread (it is already a simple text
 * request), and the answer comes back with its content type and status.
 */
export async function relayInnertube(request: Request): Promise<Response> {
  const url = parseTarget(new URL(request.url).searchParams.get('url') ?? '', isYouTubeHost);
  const session = sessionFrom(request.headers);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(url, {
    method: request.method,
    headers: innertubeHeaders(url, request.headers, session),
    body: body && body.byteLength ? body : undefined,
    redirect: 'follow',
  });
  const headers = new Headers(CORS);
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
  // InnerTube answers vary by Origin; say so, and let no cache hold a signed answer.
  headers.set('vary', 'Origin');
  headers.set('cache-control', session ? 'no-store' : 'public, max-age=60');
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * `GET /api/media?url=<googlevideo URL>`: the audio or video bytes, fetched
 * from the same egress that minted the URL. Byte ranges are forwarded both
 * ways so Shaka and `<audio>` can seek; the response is streamed, never
 * buffered whole.
 */
export async function relayMedia(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get('url') ?? '';
  const url = parseTarget(target, (host) => MEDIA_HOST.test(host));
  const range = request.headers.get('range');
  const upstream = await fetch(url, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      ...(range && { range }),
      // A media URL minted for VISIONOS is refused with a YouTube Origin
      // (web/docs/youtube-playback.md); nothing at all is what plays.
      'user-agent': CHROME_UA,
    },
    redirect: 'follow',
  });
  const isPlaylist =
    HLS_CONTENT_TYPE.test(upstream.headers.get('content-type') ?? '') || url.pathname.endsWith('.m3u8');
  if (isPlaylist && upstream.ok) {
    const headers = new Headers(CORS);
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/vnd.apple.mpegurl');
    // Signed child URLs are only useful while they live; never let a public
    // cache hold a playlist whose segments belong to one egress IP.
    headers.set('cache-control', 'private, max-age=60');
    if (request.method === 'HEAD') return new Response(null, { status: upstream.status, headers });
    const playlist = rewriteHlsPlaylist(await upstream.text(), new URL(upstream.url || url));
    return new Response(playlist, { status: upstream.status, headers });
  }

  const headers = new Headers(CORS);
  for (const name of FORWARDED_MEDIA_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'private, max-age=21262');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}

/**
 * `GET /api/lyrics?url=<provider URL>`: a lyric provider read from the relay.
 *
 * KuGou, Musixmatch, Genius and Apple’s catalogue either omit CORS headers or
 * expect a browser-ish Origin/Referer/Cookie. The extension reproduces those
 * with declarativeNetRequest; here the relay does it on the server. Only
 * hosts on LYRIC_HOSTS are ever fetched, so this is not an open proxy.
 */
export async function relayLyrics(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new RelayError(405, 'Lyrics are read with GET.');
  }
  const url = parseTarget(new URL(request.url).searchParams.get('url') ?? '', (host) => LYRIC_HOSTS.has(host));
  const headers = new Headers();
  headers.set('user-agent', CHROME_UA);
  headers.set('accept', request.headers.get('accept') ?? 'application/json, text/plain, */*');
  const language = request.headers.get('accept-language');
  if (language) headers.set('accept-language', language);
  // PaxSenix and Apple search pass a token through this header.
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);

  // The same host-specific headers the extension installs as DNR rules.
  if (url.hostname === 'amp-api.music.apple.com') {
    headers.set('origin', 'https://music.apple.com');
    headers.set('referer', 'https://music.apple.com/');
  } else if (url.hostname === 'www.musixmatch.com' || url.hostname === 'apic.musixmatch.com') {
    headers.set('cookie', 'mxm_bab=AB');
    headers.set('referer', 'https://www.musixmatch.com/');
  } else if (url.hostname === 'genius.com') {
    headers.set('referer', 'https://genius.com/');
  }

  const upstream = await fetch(url, {
    method: request.method,
    headers,
    redirect: 'follow',
  });
  const responseHeaders = new Headers(CORS);
  responseHeaders.set('content-type', upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8');
  responseHeaders.set('cache-control', 'private, max-age=60');
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/** The relay's whole surface: three routes, all same-origin. */
export async function handleRelay(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (pathname === '/api/yt') return await relayInnertube(request);
    if (pathname === '/api/media') return await relayMedia(request);
    if (pathname === '/api/lyrics') return await relayLyrics(request);
    return new Response('Not found', { status: 404, headers: CORS });
  } catch (error) {
    const status = error instanceof RelayError ? error.status : 502;
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...CORS, 'content-type': 'application/json' },
    });
  }
}

/** Whether a request path is one the relay owns. */
export function isRelayPath(pathname: string): boolean {
  return pathname === '/api/yt' || pathname === '/api/media' || pathname === '/api/lyrics';
}
