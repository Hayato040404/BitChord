# BitChord Web

The web player and its companion browser extension. The plan, and the decisions behind it, are in [`docs/web-app-build-prompt.md`](../docs/web-app-build-prompt.md).

| Package | What it is |
|---|---|
| `app/` | The site: Vite, React 19, TypeScript, React Router, TanStack Query, Zustand, Tailwind CSS v4 |
| `extension/` | Manifest V3 extension for Chromium and Firefox, built with WXT |
| `shared/` | The page ↔ extension bridge contract and client, and the relay's core, used by both |
| `functions/` | The Cloudflare Pages Function that serves the relay at `/api/*` |
| `relay/` | A self-hosted Node relay for the same routes (`node relay/server.mjs`) |
| `docs/` | `apple-music-dom.md` (the design measurements), `kira-notes.md` (how the reference YouTube web client plays), `youtube-playback.md`, `youtube-signin.md`, `portable-no-extension.md`, `deploy.md`, `queue-and-player.md`, `lyrics.md`, `spotify-and-discord.md` |
| `fixtures/` | Real captured responses for parser tests (see its README) |
| `scripts/` | `capture-fixtures.mjs` |

## Setup

Node 22 or newer. pnpm comes through corepack, so nothing needs a global install:

```bash
corepack pnpm --dir web install
```

## Run the site

```bash
corepack pnpm --dir web/app dev
```

It serves on `http://localhost:5173`, and only there (`strictPort`): the extension trusts that exact origin. It also answers on every interface (`server.host`), so a phone on the same network reaches `http://<your-ip>:5173` and exercises the no-extension path (`docs/portable-no-extension.md`).

## Phones, and the relay

An iPhone can't install the extension, and YouTube refuses InnerTube calls from any other Origin. So the app has a second way to reach YouTube: a relay on the site's own origin, which also fetches the audio from the same egress that minted its URL (googlevideo binds each URL to an IP).

- **`POST /api/yt?url=…`** forwards an InnerTube call, with the session's cookies and `SAPISIDHASH` when the page sends them.
- **`GET /api/media?url=…`** streams the audio file, forwarding byte ranges.

The same two routes are served by `app/vite.relay.ts` in development, `functions/api/[[path]].ts` on Cloudflare Pages, and `relay/server.mjs` where you host it yourself. Their logic is one dependency-free module, `shared/src/relay.ts`.

A phone gets an account by importing a **session file**: on the computer, the extension's popup has *Use on a phone → Export*, which downloads a JSON file holding the YouTube cookies; the phone imports it in **Settings › YouTube Music › Session File**. The file is stored in IndexedDB only, is never logged, and can be removed there. Without one, browsing and playback still work, anonymously.

Self-host the relay elsewhere:

```bash
node web/relay/server.mjs --port 8787     # then set VITE_RELAY_BASE_URL=http://host:8787
```

## On a phone, from your own machine

```bash
corepack pnpm --dir web/app dev        # relay included; open the printed Network: URL on the phone
corepack pnpm --dir web/app preview --host --port 4173   # the built site, likewise
```

Over a plain `http://192.168.x.x` address the player is anonymous (browsing and
playback work; the session file needs HTTPS, because `crypto.subtle` is
secure-contexts only). [`docs/deploy.md`](docs/deploy.md) has the firewall,
tunnel and HTTPS notes, plus GitHub Pages and VPS setups.

## Install the extension

Build both targets:

```bash
corepack pnpm --dir web/extension build
```

- **Chrome, Edge, Brave:** `chrome://extensions` → Developer mode → *Load unpacked* → `web/extension/.output/chrome-mv3`. The id is always `pkddffeebcmhhanjcigilehaeonkkfih`, pinned by the manifest `key` (`extension/dev-key/`), so the site finds it without configuration.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `web/extension/.output/firefox-mv3/manifest.json`.

To offer the extension as a download from the site's Extension page, package it:

```bash
corepack pnpm --dir web/extension package
```

This builds both targets and writes three files to `app/public/downloads/` (git-ignored):

- `bitchord-extension-chrome.zip` and `bitchord-extension-firefox.zip`. Each holds a single folder (`bitchord-extension-<browser>/`), so extracting it in place leaves one folder to load unpacked.
- `extension.json`, with the version. The site compares it with the installed extension's version and shows **Update** in the sidebar and an update row on the Extension page when the zip is newer. Bump `version` in `extension/package.json` to publish an update.

`VITE_EXTENSION_CHROME_URL`, `VITE_EXTENSION_FIREFOX_URL` and `VITE_EXTENSION_MANIFEST_URL` override those links, for example to point at store listings.

The toolbar icons (`extension/public/icon/`) are rendered from `app/public/favicon.svg` by `corepack pnpm --dir web/extension icons`.

Then open `http://localhost:5173/extension`. It shows "Installed", with the version and the transport: **Direct** on Chromium (`externally_connectable`), **Page relay** on Firefox (content script).

## Configuration

| Variable | Where | Default |
|---|---|---|
| `BITCHORD_SITE_ORIGINS` | extension build | `https://bitchord.in,https://bitchord-8bw.pages.dev,http://localhost:5173` (store builds leave out localhost). Comma-separated origins the extension serves; replaces the default |
| `BITCHORD_STORE_BUILD=1` | extension build | Leaves out the dev `key` for a Chrome Web Store upload |
| `VITE_EXTENSION_ID_CHROMIUM` | app (`app/.env.local`) | The pinned dev id. Set it for a store-built extension |
| `VITE_ANDROID_APP_URL` | app | The GitHub releases page |
| `VITE_PARTY_SERVER_URL` | app (`app/.env.local`, Pages env) | None. The Listen Together server; `vite build` fails without it |
| `VITE_RELAY_BASE_URL` | app (`app/.env.local`, Pages env) | Empty: the site's own origin (`/api/yt`, `/api/media`, `/api/lyrics`). Set it to a self-hosted relay's address |

## Deploy (Cloudflare Pages)

| Setting | Value |
| --- | --- |
| Root directory | `web` |
| Build command | `pnpm build:site` |
| Output directory | `app/dist` |
| Environment | `NODE_VERSION=22`, `VITE_PARTY_SERVER_URL` |

The relay needs no configuration: `functions/api/[[path]].ts` is picked up from the root directory and runs on the same deployment, so `/api/yt`, `/api/media` and `/api/lyrics` are on the site's own origin (which is what makes the session file and the extension-only lyric providers work).

`build:site` packages the extension first, so each deploy publishes the zips and `downloads/extension.json` with the version from `web/extension/package.json`. The Extension page polls that file and offers the update when it's newer than the installed one. Bump that version to make an update show.

**Render** is wired up in the root [`render.yaml`](../render.yaml): a free/paid Node web service for the relay and a static site for the app. In Render, choose **New → Blueprint** and connect the repository; the static site's `VITE_RELAY_BASE_URL` is filled from the relay automatically. See [`docs/deploy.md`](docs/deploy.md#render).

**GitHub Pages** works for the site itself, but Pages can't run the relay, so it must be hosted elsewhere and named in `VITE_RELAY_BASE_URL`; `.github/workflows/pages.yml` builds and publishes it when run manually. **Self-hosting** (a LAN box, a VPS) is one command: `pnpm --filter @bitchord/app dev` or `preview --host` serves the site and the relay together. Both are written up in [`docs/deploy.md`](docs/deploy.md).

## Checks

```bash
corepack pnpm --dir web -r typecheck
corepack pnpm --dir web -r test      # vitest: shared/relay.test.ts, app/src/portable/session.test.ts, …
corepack pnpm --dir web/app build
```
