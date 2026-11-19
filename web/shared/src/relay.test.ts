import { describe, expect, it } from 'vitest';
import {
  CORS,
  handleRelay,
  isRelayPath,
  RelayError,
  relayInnertube,
  relayLyrics,
  relayMedia,
  sessionFrom,
} from './relay';

// The relay is the reason a phone without an extension can reach YouTube at
// all, so its surface is tested where the network ends: host allow-lists,
// session headers, and the two routes.

function call(path: string, init: RequestInit = {}): Request {
  return new Request(`https://bitchord.example${path}`, init);
}

const target = (host: string) => `https://${host}/youtubei/v1/browse`;
const yt = (url: string) => `/api/yt?url=${encodeURIComponent(url)}`;
const media = (url: string) => `/api/media?url=${encodeURIComponent(url)}`;
const lyrics = (url: string) => `/api/lyrics?url=${encodeURIComponent(url)}`;

describe('isRelayPath', () => {
  it('owns exactly the three routes', () => {
    expect(isRelayPath('/api/yt')).toBe(true);
    expect(isRelayPath('/api/media')).toBe(true);
    expect(isRelayPath('/api/lyrics')).toBe(true);
    expect(isRelayPath('/api/presence')).toBe(false);
    expect(isRelayPath('/')).toBe(false);
  });
});

describe('sessionFrom', () => {
  it('is null unless all three headers are present', () => {
    expect(sessionFrom(new Headers())).toBeNull();
    expect(sessionFrom(new Headers({ 'x-bitchord-cookie': 'a=b' }))).toBeNull();
    expect(sessionFrom(new Headers({ 'x-bitchord-cookie': 'a=b', authorization: 'SAPISIDHASH 1_0' }))).toBeNull();
  });

  it('reads the cookie, signature and auth user', () => {
    const session = sessionFrom(
      new Headers({
        'x-bitchord-cookie': 'SAPISID=abc; SID=def',
        authorization: 'SAPISIDHASH 123_ff',
        'x-bitchord-auth-user': '2',
      }),
    );
    expect(session).toEqual({ cookie: 'SAPISID=abc; SID=def', authorization: 'SAPISIDHASH 123_ff', authUser: '2' });
  });
});

describe('handleRelay', () => {
  it('answers OPTIONS with the CORS headers, on any path', async () => {
    const response = await handleRelay(call('/api/yt', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(CORS['access-control-allow-origin']);
  });

  it('404s a path it does not own, still with CORS', async () => {
    const response = await handleRelay(call('/api/other'));
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses a target that is not a YouTube host', async () => {
    const response = await handleRelay(call(yt('https://example.com/youtubei/v1/browse'), { method: 'POST' }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('example.com') });
  });

  it('refuses http, so the session never travels in the clear', async () => {
    const response = await handleRelay(call(yt('http://music.youtube.com/youtubei/v1/browse'), { method: 'POST' }));
    expect(response.status).toBe(403);
  });

  it('refuses a media URL on a host that is not googlevideo', async () => {
    const response = await handleRelay(call(media('https://example.com/a.m4a')));
    expect(response.status).toBe(403);
  });

  it('refuses a missing or unparseable URL with 400', async () => {
    const missing = await handleRelay(call('/api/media'));
    expect(missing.status).toBe(400);
    const bad = await handleRelay(call('/api/yt?url=not%20a%20url', { method: 'POST' }));
    expect(bad.status).toBe(400);
  });
});

describe('relayInnertube', () => {
  it('sends YouTube the Origin and a web client, forwards the body, strips the session when absent', async () => {
    const original = globalThis.fetch;
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await relayInnertube(
        call(yt(target('music.youtube.com')), { method: 'POST', body: '{"context":{}}', headers: { 'content-type': 'text/plain' } }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toContain('public');
      const headers = new Headers(seen!.init.headers);
      expect(headers.get('origin')).toBe('https://music.youtube.com');
      expect(headers.get('x-origin')).toBe('https://music.youtube.com');
      expect(headers.get('referer')).toBe('https://music.youtube.com/');
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
      // The body is passed through byte for byte (it was read as an ArrayBuffer).
      expect(new TextDecoder().decode(seen!.init.body as ArrayBuffer)).toBe('{"context":{}}');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('adds the session and forbids caching a signed answer', async () => {
    const original = globalThis.fetch;
    let headers = new Headers();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const response = await relayInnertube(
        call(yt(target('www.youtube.com')), {
          method: 'POST',
          body: '{}',
          headers: {
            'x-bitchord-cookie': 'SAPISID=abc',
            authorization: 'SAPISIDHASH 1_ff',
            'x-bitchord-auth-user': '0',
          },
        }),
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(headers.get('cookie')).toBe('SAPISID=abc');
      expect(headers.get('authorization')).toBe('SAPISIDHASH 1_ff');
      expect(headers.get('x-goog-authuser')).toBe('0');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does not forward a client-chosen header it did not allow', async () => {
    const original = globalThis.fetch;
    let headers = new Headers();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await relayInnertube(
        call(yt(target('music.youtube.com')), {
          method: 'POST',
          body: '{}',
          headers: { 'x-bitchord-cookie': 'forged=1', origin: 'https://evil.example' },
        }),
      );
      // The forged cookie is the session's own channel, and Origin is the relay's; neither is passed through.
      expect(headers.get('origin')).toBe('https://music.youtube.com');
      expect(headers.get('x-bitchord-cookie')).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('relayMedia', () => {
  it('forwards the byte range and streams the upstream answer', async () => {
    const original = globalThis.fetch;
    let headers = new Headers();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response('bytes', {
        status: 206,
        headers: { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-4/100', 'content-length': '5' },
      });
    }) as typeof fetch;
    try {
      const response = await relayMedia(
        call(media('https://rr1---sn-abc.googlevideo.com/videoplayback?ip=1.2.3.4'), { headers: { range: 'bytes=0-4' } }),
      );
      expect(response.status).toBe(206);
      expect(headers.get('range')).toBe('bytes=0-4');
      expect(response.headers.get('content-range')).toBe('bytes 0-4/100');
      expect(response.headers.get('content-type')).toBe('audio/mp4');
      expect(response.headers.get('access-control-expose-headers')).toContain('content-range');
      await expect(response.text()).resolves.toBe('bytes');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('answers HEAD without a body', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('bytes', { status: 200, headers: { 'content-length': '5' } })) as typeof fetch;
    try {
      const response = await relayMedia(call(media('https://rr1---sn-abc.googlevideo.com/videoplayback'), { method: 'HEAD' }));
      expect(await response.text()).toBe('');
      expect(response.headers.get('content-length')).toBe('5');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports an upstream failure as 502 with a message', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    try {
      const response = await handleRelay(call(media('https://rr1---sn-abc.googlevideo.com/videoplayback')));
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ error: 'network down' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('relayLyrics', () => {
  it('fetches an allowed lyric host with browser headers and forwards a token', async () => {
    const original = globalThis.fetch;
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await relayLyrics(
        call(lyrics('https://amp-api.music.apple.com/v1/catalog/us/search?term=x'), {
          headers: { authorization: 'Bearer token', accept: 'application/json' },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toBe('private, max-age=60');
      const headers = new Headers(seen!.init.headers);
      expect(headers.get('authorization')).toBe('Bearer token');
      expect(headers.get('origin')).toBe('https://music.apple.com');
      expect(headers.get('referer')).toBe('https://music.apple.com/');
      expect(headers.get('user-agent')).toContain('Chrome/');
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('adds Musixmatch’s web cookie but never a caller’s cookie', async () => {
    const original = globalThis.fetch;
    let headers = new Headers();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      await relayLyrics(call(lyrics('https://apic.musixmatch.com/ws/1.1/track.search'), { headers: { cookie: 'session=evil' } }));
      expect(headers.get('cookie')).toBe('mxm_bab=AB');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses any host that is not a lyric provider', async () => {
    const response = await handleRelay(call(lyrics('https://example.com/lyrics')));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('example.com') });
  });

  it('only reads', async () => {
    const response = await handleRelay(call(lyrics('https://genius.com/api/search/multi'), { method: 'POST' }));
    expect(response.status).toBe(405);
  });
});

describe('RelayError', () => {
  it('keeps its status', () => {
    expect(new RelayError(403, 'no').status).toBe(403);
    expect(new RelayError(403, 'no').name).toBe('RelayError');
  });
});
