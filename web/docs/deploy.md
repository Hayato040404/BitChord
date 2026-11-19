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
| Render + Raspberry Pi | static site (`render.yaml`) | `relay/server.mjs` on the Pi, through Cloudflare Tunnel | no |
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

[`render.yaml`](../../render.yaml) creates the **static app only**. The relay is
deliberately not hosted on Render: YouTube blocks Render's shared datacenter
egress with `403 Sorry...`, so a Render relay cannot play music reliably. Run
the relay on a Raspberry Pi (or VPS) and expose it through Cloudflare Tunnel.

| Service | Type | Root | Build | Publish |
|---|---|---|---|---|
| `bitchord-web-hayato` | static site | `web` | `npm install --global pnpm@12.11.2 && pnpm install --frozen-lockfile && pnpm build:site` | `app/dist` |

The static site has an SPA rewrite so `/home` and other client-side routes
survive a refresh. `VITE_RELAY_BASE_URL` is marked `sync: false` in the
Blueprint: set it to the tunnel URL in the Render dashboard.

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, connect the repository, and click **Apply**.
3. Open the `bitchord-web-hayato` service → **Environment**, set
   `VITE_RELAY_BASE_URL` to the HTTPS tunnel URL from below (no trailing
   slash), and save.
4. Click **Manual Deploy → Deploy latest commit**. Vite bakes the relay URL in
   at build time, so an environment change alone does not update the site.
5. Open the static site's `onrender.com` URL.
6. Optional: replace `VITE_PARTY_SERVER_URL` if you run the Listen Together
   WebSocket server, then redeploy.

If you previously created the Render relay service, it is safe to suspend or
delete it **after** the static site points at the tunnel. It is not used.

## Raspberry Pi + Cloudflare Tunnel

This is the recommended relay setup: the Pi fetches YouTube and lyric hosts
from a residential IP, while Cloudflare only forwards inbound HTTPS. No router
port-forwarding is needed, and the Pi can stay behind NAT.

### 1. Prepare the Pi

Use a 64-bit Raspberry Pi OS (Pi 4 or 5 recommended), wired Ethernet if
possible, and Node 22.18 or newer.

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

Clone the repository:

```bash
git clone https://github.com/Hayato040404/BitChord.git
cd BitChord
```

The relay has no npm dependencies, so no `pnpm install` is needed just to run
it.

### 2. Run the relay

```bash
node --experimental-strip-types web/relay/server.mjs --port 8787 --host 127.0.0.1
```

From another terminal on the Pi:

```bash
curl http://127.0.0.1:8787/health
# ok
```

Leave the relay bound to `127.0.0.1`: Cloudflare Tunnel reaches it locally, and
the port does not need to be exposed to the LAN or the internet.

Install it as a service so it survives reboots:

```bash
sudo tee /etc/systemd/system/bitchord-relay.service >/dev/null <<'EOF'
[Unit]
Description=BitChord relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/BitChord
ExecStart=/usr/bin/node --experimental-strip-types web/relay/server.mjs --port 8787 --host 127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now bitchord-relay
sudo systemctl status bitchord-relay
```

Change `User=pi` and the two `/home/pi/...` paths if your Pi user is
different. Check the Node path with `which node`; NodeSource installs it at
`/usr/bin/node`.

### 3. Install cloudflared

Check the architecture first:

```bash
uname -m
```

For `aarch64` use the `arm64` package; for `armv7l` use `armhf`.

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

### 4. Get an HTTPS URL

**Quick tunnel (test first, URL changes on restart):**

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a URL such as `https://random-words.trycloudflare.com`. Test it from
another network:

```bash
curl https://random-words.trycloudflare.com/health
```

Set that URL as `VITE_RELAY_BASE_URL` in Render and redeploy. This is enough to
verify that YouTube playback works from your home IP.

**Stable tunnel (recommended for daily use):**

A stable hostname needs a domain whose DNS is managed by Cloudflare. A cheap
domain is enough; Cloudflare's DNS/proxy plan is free.

1. Add the domain to Cloudflare and change its nameservers at the registrar.
2. In Cloudflare **Zero Trust → Networks → Tunnels**, create a tunnel of type
   **Cloudflared** and copy the token.
3. On the Pi, install the connector with that token:

   ```bash
   sudo cloudflared service install <TOKEN>
   sudo systemctl status cloudflared
   ```

4. In the tunnel's **Public Hostname** settings add:

   ```text
   Subdomain: relay
   Domain:    example.com
   Service:   http://127.0.0.1:8787
   ```

   Cloudflare creates the DNS record automatically.

5. Do **not** put Cloudflare Access in front of this hostname; the BitChord app
   is not a browser SSO client and would receive the Access login page instead
   of relay responses.

Use `https://relay.example.com` as `VITE_RELAY_BASE_URL`.

### 5. Point Render at the tunnel and verify

In Render's static service → **Environment**:

```text
VITE_RELAY_BASE_URL=https://relay.example.com
```

Save, then **Manual Deploy → Deploy latest commit**. Vite reads this variable at
build time, so the redeploy is mandatory.

Verify from outside the Pi:

```bash
curl https://relay.example.com/health
```

Then open the Render app, play a track, and open lyrics. The requests to
`/api/yt`, `/api/media`, and `/api/lyrics` now go to the Pi, while the page
itself stays on Render.

### Troubleshooting

- **502 from the tunnel:** the relay is not running, or the tunnel's service
  URL/port is wrong. Check `systemctl status bitchord-relay` and
  `curl 127.0.0.1:8787/health`.
- **403 from YouTube:** the home IP is blocked (rare on residential
  connections) or the request is not reaching the Pi. Check the relay log.
- **CORS error in the browser:** `VITE_RELAY_BASE_URL` is wrong or the static
  site was not rebuilt after changing it.
- **Mixed-content error:** the tunnel URL must be `https://`.
- **URL changed after reboot:** the quick tunnel is temporary; switch to a named
  tunnel with your own hostname.
- **Pi sleeps or loses power:** disable sleep, use Ethernet, and enable the
  systemd services so relay and tunnel restart automatically.
- **`cloudflared` can't connect:** check outbound HTTPS/DNS from the Pi; no
  inbound port needs to be opened.

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
