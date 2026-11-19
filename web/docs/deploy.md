# Hosting it yourself

Two things have to be true for the player to work without the extension: the
site is served (any static host will do), and `/api/yt` and `/api/media` answer
on some origin ([`portable-no-extension.md`](portable-no-extension.md) explains
why the second is needed at all). Add `/api/lyrics` on the same relay if the
extension-only lyric providers (KuGou, Musixmatch, Genius, PaxSenix) should
work on a phone too.

| Host | The site | The relay | One command? |
|---|---|---|---|
| Cloudflare Pages | `functions/api/[[path]].ts` | same deployment, same origin | yes |
| Render | static site + Node web service (`render.yaml`) | the Node service, separate origin | yes |
| Your own machine, other devices on the LAN | `pnpm dev` / `pnpm preview` | the same server | yes |
| GitHub Pages | `app/dist` as static files | **must be elsewhere** (Pages can't run code) | no |
| Any static host / VPS / NAS | the files | `node web/relay/server.mjs` | no |

## Cloudflare Pages

Root directory `web`, build command `pnpm build:site`, output `app/dist`,
`NODE_VERSION=22`, and `VITE_PARTY_SERVER_URL` in the environment. The relay is
the Pages Function, on the same origin, so nothing else is configured.

## From your own machine (phone on the same Wi-Fi)

This is the quickest way to try it on a phone, and the relay is built in — one
process serves the site *and* `/api/*`.

```bash
cd web
corepack pnpm install
echo 'VITE_PARTY_SERVER_URL=http://127.0.0.1:8080' > app/.env.local   # any value; only Listen Together uses it

# development server, hot reload, port 5173, reachable on the LAN
corepack pnpm --filter @bitchord/app dev
```

or a production-like build:

```bash
corepack pnpm --filter @bitchord/app build
corepack pnpm --filter @bitchord/app preview --host --port 4173
```

Either prints a **Network:** line, e.g. `http://192.168.3.36:5173/`. Open that
on the phone.

Things to know on a plain-HTTP LAN address:

- **Browsing and playback work; signing in does not.** The session file is
  signed in the page with `crypto.subtle`, which browsers only expose on
  *secure* origins (HTTPS, or `localhost`). Over `http://192.168.x.x` the app
  says so instead of failing quietly. Without a session the player is
  anonymous: search, home, albums, artists and playback all work; the library
  and likes don't.
- If the phone can't connect, the machine's firewall is usually the cause:
  `sudo ufw allow 5173/tcp` (or 4173 for `preview`), and check both devices are
  on the same network without client isolation.
- `curl http://192.168.3.36:5173/api/yt -X OPTIONS -i` should answer `204`.
- The dev server is for trying it out; a phone that's going to be used
  regularly wants the deployed build, over HTTPS.

To get a **secure** LAN address, either put a real domain in front of it (Caddy
or nginx with a certificate) or use a tunnel:

```bash
# any of these gives an HTTPS URL the phone can open
cloudflared tunnel --url http://localhost:5173
tailscale serve --bg 5173          # then open the tailnet's https:// name
ngrok http 5173
```

## Render

The repository includes a [`render.yaml`](../../render.yaml) Blueprint that
creates both halves:

| Service | Type | Root | Build | Publish / start |
|---|---|---|---|---|
| `bitchord-relay-hayato` | Node web service | `web` | `npm install --global pnpm@12.11.2` | `node --experimental-strip-types relay/server.mjs --port $PORT` |
| `bitchord-web-hayato` | static site | `web` | `npm install --global pnpm@12.11.2 && pnpm install --frozen-lockfile && pnpm build:site` | `app/dist` |

The static site's `VITE_RELAY_BASE_URL` is taken from the relay's
`RENDER_EXTERNAL_URL`, and the relay listens on Render's `$PORT`. The static
site has an SPA rewrite so `/home` and other client-side routes survive a
refresh.

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, connect the repository, and click **Apply**.
3. If Render reports that a service name is taken, change both the service name
   and the `fromService.name` reference in `render.yaml` to a unique name.
4. Open the static site's `onrender.com` URL.
5. Optional: replace the `VITE_PARTY_SERVER_URL` placeholder if you run the
   Listen Together WebSocket server, then redeploy the static site.

Render's free **web service** spins down after inactivity; the first request
after a nap can take tens of seconds, which is poor for a music player. Use the
Starter plan for the relay if it matters. Static sites do not spin down.

Render sends outbound traffic through shared regional IP ranges. The relay's
`/api/yt` and `/api/media` calls normally leave from the same running instance,
but Render does not promise a single egress IP. If YouTube starts answering 403
for media after a restart, that is the IP binding described at the bottom of
this page; reloading the track mints a fresh URL from the current egress. A
dedicated outbound IP set (Pro workspace) is the fully stable option.

If you prefer the dashboard over the Blueprint, create the two services
manually with the table above, add `NODE_VERSION=22.18.0` to both, and set
`VITE_RELAY_BASE_URL` on the static site to the relay's public URL.

## GitHub Pages

Pages serves **files only**: there is no place for `/api/*`, so the relay has
to live somewhere else, and the site has to be built knowing where.
`.github/workflows/pages.yml` can do this when run manually. Render is the
default deployment, so the workflow no longer runs on every push:

1. installs from `web/`;
2. runs `pnpm build:site`, which packages the extension and builds the app with
   `BITCHORD_BASE=/<repo>/` (the project-site path) and
   `VITE_RELAY_BASE_URL` from a repository variable;
3. publishes `web/app/dist` with `actions/deploy-pages`.

The workflow is already in this repository (`.github/workflows/pages.yml`).
Set it up on the fork:

```bash
# The relay's public HTTPS origin, no trailing slash needed.
gh variable set VITE_RELAY_BASE_URL --body 'https://relay.example.com'

# Only needed for Listen Together. Any non-empty HTTPS value satisfies the
# build; without a real party server that screen just won't connect.
gh variable set VITE_PARTY_SERVER_URL --body 'https://relay.example.com'
```

Then **Settings → Pages → Source: GitHub Actions**, run the workflow from the
Actions tab (or `gh workflow run pages.yml`), and open
`https://<user>.github.io/<repo>/`.

### The relay behind GitHub Pages

The relay is a small Node 22 HTTP server, [`relay/server.mjs`](../relay/server.mjs).
It writes nothing to disk and keeps no session; cookies and `SAPISIDHASH` ride
along per request. It must be reachable over **HTTPS** (the browser's
`crypto.subtle` is secure-context only, so signing in and `/api/yt` need it).

Where to run it, roughly best to worst for this app:

| Service | Cost | Suitability |
|---|---|---|
| A small VPS (ConoHa, Sakura, Hetzner, DigitalOcean) | ~$3–6/month | **Best.** Always on, one stable public IP for both `/api/yt` and `/api/media`, no sleep. |
| A home PC / Raspberry Pi / NAS + Cloudflare Tunnel | free | **Excellent** if it stays on: the relay's egress is your home IP, and one tunnel gives it HTTPS. |
| Fly.io / Render / Railway / Koyeb | free tier or ~$5/month | Works, but free instances sleep and get a new egress IP. Use an always-on paid instance. |
| Cloudflare Workers / Pages Functions | free | Easiest to deploy, but Cloudflare's egress IP/colo is not guaranteed to stay the same between the InnerTube call and the media fetch, and YouTube may challenge it. Treat it as best-effort, not "complete". |

Whichever you pick, **`/api/yt` and `/api/media` must use the same egress IP**:
googlevideo binds each media URL to the IP that minted it. That is why a
self-hosted relay (VPS or home line) is the reliable answer, and why sending
the InnerTube call through one service and the media through another tends to
produce 403s.

A VPS with Caddy, in full:

```bash
# On the VPS, with Node 22+ and the repo checked out
node web/relay/server.mjs --port 8787
```

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Cloudflare Tunnel from a home machine is the same Node command plus:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the resulting `https://…trycloudflare.com` (or a named tunnel on your own
domain) as `VITE_RELAY_BASE_URL`. A named tunnel is preferable: the quick
tunnel's hostname changes when it restarts.

Do **not** point `VITE_RELAY_BASE_URL` at a plain `http://` address: GitHub
Pages is HTTPS, so the browser blocks mixed content before the app starts.

GitHub Pages' own limits apply: 1 GB per site, 100 GB/month of traffic, a build
must finish in 10 minutes. The repo ships the two ONNX models (30 MB), so the
published site is about 40 MB — fine, but Automix's models are fetched on first
use, not with the page.

## Lyrics without the extension

With a relay deployed, phones get the same lyric providers as the desktop
extension. The app asks `/api/lyrics?url=…` for the hosts that don't send CORS
headers (KuGou, Musixmatch, Genius, Apple's catalogue, PaxSenix). The relay has
a closed allowlist, adds the `Origin`/`Referer`/cookie those hosts expect, and
forwards the PaxSenix/Apple `Authorization` header. No relay means only the
CORS-friendly providers (LRCLIB, Bini, BetterLyrics, Unison, lyrics.plus) work;
Settings says which situation the device is in.

Genius is the one provider that can still fail from a server: it sometimes
serves a Cloudflare captcha to data-centre IPs. The desktop extension avoids
that because it fetches from the user's own browser. If Genius is important,
run the relay on a home connection rather than a cloud VPS.

## Any static host + the relay

The same as GitHub Pages, without the `BITCHORD_BASE` bit: serve
`web/app/dist` at the origin's root, build with
`VITE_RELAY_BASE_URL=https://relay.example.com`, and run
`node web/relay/server.mjs` on the relay host. If you'd rather have one origin,
put both behind one reverse proxy:

```caddy
music.example.com {
    handle /api/* {
        reverse_proxy 127.0.0.1:8787
    }
    handle {
        root * /srv/bitchord
        try_files {path} /index.html
        file_server
    }
}
```

With one origin, `VITE_RELAY_BASE_URL` can be left empty.

## What a phone still can't do

- **Install the extension.** That's the point of the relay. Without it: no
  Spotify and no Discord presence. Lyrics work through `/api/lyrics` when a
  relay is deployed (Genius may challenge a cloud IP).
- **Sign in without HTTPS.** See above.
- **Play age-restricted tracks anonymously**; the session file covers them.

The session file itself is exported on a computer (**extension popup → Use on a
phone → Export**) and imported on the phone under **Settings › YouTube Music ›
Session File**.
