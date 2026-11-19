#!/usr/bin/env node
/**
 * A self-hosted relay for BitChord's no-extension path
 * (web/shared/src/relay.ts), for people who run the site themselves.
 *
 * Cloudflare Pages deploys the same logic as a Function
 * (web/functions/api/[[path]].ts); this file is for a plain Node box:
 *
 *   node web/relay/server.mjs --port 8787
 *
 * Then point the app at it with VITE_RELAY_BASE_URL=http://your-host:8787
 * and, if it is another origin, allow that origin in CORS below (the relay
 * answers `*`, which is enough for the player but not for cookies: it never
 * uses cookies of its own).
 *
 * It reads no session itself: cookies and the SAPISIDHASH arrive per request
 * from the page's imported session file, exactly as on Pages.
 */
import { createServer } from 'node:http';
import { handleRelay } from '../shared/src/relay.ts';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get('--port') ?? process.env.PORT ?? 8787);
const host = args.get('--host') ?? process.env.HOST ?? '0.0.0.0';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${port}`}`);
    if (url.pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('ok');
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const method = req.method ?? 'GET';
    void handleRelay(new Request(url, { method, headers, ...(body && method !== 'GET' && method !== 'HEAD' && { body }) }))
      .then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        res.end();
      })
      .catch((error) => {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
});

server.listen(port, host, () => {
  console.log(`BitChord relay listening on http://${host}:${port} (routes /api/yt, /api/media, /api/lyrics)`);
});
