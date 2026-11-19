import { handleRelay } from '../../shared/src/relay';

/**
 * Cloudflare Pages Function: `/api/*` on the site's own origin.
 *
 * The site is deployed from `web/` (root directory) with `app/dist` as the
 * output, so this file lands at `functions/api/[[path]].ts` and Pages serves
 * `/api/yt`, `/api/media` and `/api/lyrics` from the same origin as the player.
 * That is what makes the relay work without CORS at all, and what makes a
 * phone's audio play: the URL googlevideo mints is bound to the relay's IP,
 * and the relay is the one fetching it (shared/src/relay.ts).
 *
 * Pages Functions are bundled from this directory; the shared relay is plain
 * TypeScript with no dependencies, so the bundler needs nothing else.
 */
interface PagesContext {
  request: Request;
}

export const onRequest = (context: PagesContext): Response | Promise<Response> => handleRelay(context.request);
