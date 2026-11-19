import { handleRelay, isRelayPath } from '@bitchord/shared/relay';
import type { Connect, Plugin } from 'vite';

/** The two routes, as connect middleware: the same logic the Pages Function runs (shared/src/relay.ts). */
function relayMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    if (!isRelayPath(pathname)) return next();
    // `req` is a Node request and `fetch` needs a web one; the headers and
    // body are all the relay reads, so a Request built from them is exact.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const method = req.method ?? 'GET';
      void handleRelay(
        new Request(url, { method, headers, ...(body && method !== 'GET' && method !== 'HEAD' && { body }) }),
      )
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
        .catch((error: unknown) => {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
    });
  };
}

/**
 * The relay on the dev server (shared/src/relay.ts): `/api/yt`,
 * `/api/media` and `/api/lyrics` behave exactly as they do on Cloudflare
 * Pages, so the no-extension path can be developed and tested on a phone
 * against `http://<your-laptop>:5173` before anything is deployed.
 *
 * `vite preview` gets the same middleware, so a built site can be tried on a
 * phone too (`pnpm preview --host`), which is the simplest self-hosting there
 * is: one process, one origin, no configuration.
 */
export function relayPlugin(): Plugin {
  return {
    name: 'bitchord-relay',
    configureServer(server) {
      server.middlewares.use(relayMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(relayMiddleware());
    },
  };
}
