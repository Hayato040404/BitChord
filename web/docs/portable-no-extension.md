# Phones, and playing without the extension

An iPhone (or any browser that can't install the extension) still gets the whole
player. Two things make that work: a session file, exported on a computer, and a
relay on the site's own origin.

## Why a relay is needed

The extension fixes YouTube's CORS refusals with `declarativeNetRequest`: it
rewrites the `Origin`/`Referer` headers on `music.youtube.com/youtubei/*` so the
call looks like YouTube's own page. A browser page can't do that. Without the
extension, YouTube answers **403** to every InnerTube call.

The relay moves the call to the server: `POST /api/yt?url=…` makes the request
from the deployment's own address and returns YouTube's JSON unchanged.

Playback needs the same egress. Every `googlevideo` URL carries the IP it was
minted for inside `sparams` (`ip=<egress>`); fetching it from another address,
or with the `ip` parameter altered, answers 403, and YouTube ignores
`X-Forwarded-For` when minting the URL. So the relay also serves
`GET /api/media?url=…`, streaming the file from the machine that asked for it.

Both routes are one dependency-free module, [`shared/src/relay.ts`](../shared/src/relay.ts),
served by:

| Where | Serves `/api/yt`, `/api/media`, `/api/lyrics` | How |
|---|---|---|
| Cloudflare Pages | `functions/api/[[path]].ts` | automatic from the Pages root |
| Development | `app/vite.relay.ts` | the Vite dev server's middleware |
| Self-hosted | `relay/server.mjs` | `node web/relay/server.mjs --port 8787` |

`VITE_RELAY_BASE_URL` points the app at a relay elsewhere; empty means this
origin.

## The portable engine

`app/src/playback/youtube/portableEngine.ts` is chosen instead of the
extension's engine whenever the backend is the relay.

The extension's engine uses YouTube's web clients and DASH/SABR: both need
YouTube's `Origin`, and SABR needs a WebPO token. A phone has neither. So the
portable engine asks what a native app asks for — an `IOS`, `VISIONOS` or
`ANDROID_VR` player response — and those answer `OK` with plain progressive
formats and no integrity token. It takes the best `audio/mp4` format,
deciphers `sig`/`n` with the player script as usual, and points a plain
`<audio>` element at the URL through `/api/media`.

That choice is what makes iOS behave:

- On iPhone/iPad (Safari and iOS Chrome, which is WebKit underneath), the
  engine uses YouTube's HLS audio playlist instead: `/api/media` rewrites the
  master and media playlists so every segment is same-origin, and AVFoundation
  plays the HLS natively. It reports the real duration and starts after the
  first small segment instead of waiting for the whole MP4.
- This also avoids a WebKit bug in which YouTube's fragmented MP4 is read as
  *twice* its length: a three-minute song showed six minutes, with three
  minutes of silence after the music. The UI now takes the duration from track
  metadata (`getDuration()`), and ends the track at that point if a browser
  still reports a doubled `audio.duration`.
- Chrome/Android cannot demux YouTube's packed ADTS HLS audio, so they keep the
  progressive AAC file; seeking there uses HTTP byte ranges.
- `navigator.mediaSession` gives the lock screen title, artwork and transport
  (`app/src/state/player.ts`), and the `<audio>` element keeps playing when the
  screen locks.
- Autoplay is blocked until a tap, which the player already handles: the first
  tap on a song is that tap.

A music video's picture is not streamed; the artwork stands in, which is what
an audio-first phone player shows anyway. `videoStream()` returns `null`.

Age-restricted tracks need the session file (below): anonymous IOS clients are
refused those.

## The session file

A phone can't have the browser's YouTube cookies, so the desktop extension
exports them:

1. On the computer, open the BitChord extension's popup and choose
   **Use on a phone → Export**. It downloads `bitchord-session-<date>.json`.
2. Get the file to the phone (AirDrop, iCloud Drive, email, a local transfer —
   it is a small JSON file).
3. On the phone, **Settings › YouTube Music › Session File › Import** and pick
   it.

The file holds `format`, `version`, `exportedAt`, and `youtube: { cookies,
sapisid, authUser, account }` (`shared/src/bridge/protocol.ts`).

What happens with it:

- The page computes the `SAPISIDHASH` itself (`app/src/portable/relay.ts`) and
  sends the cookie, signature and `X-Goog-AuthUser` as three headers on each
  InnerTube call. The relay never holds the secret beyond one request.
- The browser origin can't set `Cookie` for `music.youtube.com`; that's exactly
  why the relay takes the header.
- With a session, YouTube answers as the account: library, playlists, likes and
  history reporting work.

Rules the code keeps:

- **The extension popup is the only writer.** `yt.exportSession` is in
  `OWN_PAGES_ONLY`, and the background refuses any caller that isn't an
  extension page (`isOwnPage`), so a web page can't ask the extension for the
  cookies.
- **The phone keeps it in IndexedDB only** (`app/src/portable/session.ts`), never
  `localStorage`, never a query cache, never the log. Only the account's name and
  picture are put in React state.
- **It can be removed** in the same settings row; removing re-reads the auth
  state and drops everything cached as the old identity.
- Signing out of YouTube on the computer makes the file useless; changing the
  password does too.

## What still needs the extension

Spotify (its tokens need the extension's host access), Discord presence, and
Apple Music host permissions. The extension-only lyric providers are **not** in
this list any more when a relay is deployed: the phone reaches them through
`/api/lyrics` (Genius can still be captcha-blocked from a cloud IP). With no
relay at all, only the CORS-friendly lyric providers work. YouTube Music,
addons that don't need host access, and the Apple Music *public* pages work
without it.
