import type { Innertube, YT } from 'youtubei.js/web';
import { relayedMediaUrl } from '@/portable/relay';
import { trackLog } from '../trackLog';
import { getInnertube } from './innertube';
import type { LoadedTrack, PlaybackEngine, StreamStats, VideoStream } from './engine';

/**
 * YouTube playback without an extension (portable/relay.ts).
 *
 * The extension's engine walks YouTube's web clients and streams DASH or
 * SABR. A phone can't do either: web clients answer "The page needs to be
 * reloaded" without YouTube's Origin, SABR needs the same, and every
 * googlevideo URL is bound to the IP that minted it (`sparams` carries `ip`).
 *
 * So this engine asks for what a native app asks for: an Apple or Vision
 * client's plain, progressive audio file (an AAC MP4), deciphered as usual for
 * `sig`/`n`, and points a plain `<audio>` element at it through the relay.
 * Safari plays it natively, iOS keeps it alive in the background with the
 * lock screen's controls, and seeking is the media element's own ranged
 * requests, which the relay forwards.
 *
 * None of the clients used here take a WebPO token, so BotGuard never runs on
 * this path. A music video's picture isn't streamed: the artwork stands in,
 * which is what the phone's audio-first player shows anyway.
 */

/** The clients that answer with direct media URLs and need no integrity token. */
const PORTABLE_CLIENTS = ['IOS', 'VISIONOS', 'ANDROID_VR'] as const;
type PortableClient = (typeof PORTABLE_CLIENTS)[number];

/** What each client presents; the phone's own clients, so YouTube answers as it would to them. */
const CLIENT_CONTEXT: Record<PortableClient, Record<string, unknown>> = {
  IOS: {
    clientName: 'IOS',
    clientVersion: '20.10.4',
    deviceMake: 'Apple',
    deviceModel: 'iPhone16,2',
    osName: 'iPhone',
    osVersion: '18.3.2.22D82',
    platform: 'MOBILE',
  },
  VISIONOS: {
    clientName: 'VISIONOS',
    clientVersion: '0.1',
    osName: 'VISION_OS',
    osVersion: '1.0.0',
    platform: 'MOBILE',
  },
  ANDROID_VR: {
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.27',
    osName: 'Android',
    osVersion: '12',
    platform: 'MOBILE',
    androidSdkVersion: 32,
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
  },
};

/** Waiting longer than this for the browser to accept the file means the stream won't start. */
const FIRST_AUDIO_TIMEOUT_MS = 20_000;
/** A manifest fetch that hangs must not hold up the progressive fallback. */
const HLS_TIMEOUT_MS = 8_000;

/**
 * Safari's native HLS is the one transport that gives an iPhone a correct
 * duration. Chromium also answers `maybe` to `canPlayType` for an m3u8, but
 * it can't demux YouTube's packed ADTS audio, so asking it would only delay
 * the progressive fallback. Gate on Apple's media stack, not the MIME probe:
 * iOS Chrome is WebKit underneath and still has HLS, while Mac Chrome doesn't.
 */
function supportsHls(audio: HTMLAudioElement): boolean {
  const ua = navigator.userAgent;
  const apple = /Apple/.test(navigator.vendor) || /iPhone|iPad|iPod/i.test(ua);
  return apple && (audio.canPlayType('application/vnd.apple.mpegurl') !== '' || audio.canPlayType('application/x-mpegURL') !== '');
}

/** One `#EXT-X-MEDIA` audio rendition from YouTube's HLS master. */
interface HlsAudioRendition {
  group: string;
  uri: string;
  isDefault: boolean;
  /** The source itag in the URI, used to prefer 140 (AAC 130 kbps) over 139 (50 kbps). */
  itag: number;
}

/**
 * The audio renditions in a master playlist. YouTube's music master has no
 * `#EXT-X-STREAM-INF` variants at all: just audio groups (and subtitle tracks),
 * so an audio element should be pointed at one of these media playlists.
 */
function hlsAudioRenditions(master: string): HlsAudioRendition[] {
  const lines = master.split(/\r?\n/);
  const renditions: HlsAudioRendition[] = [];
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/(?:^|,)\s*TYPE=AUDIO(?:,|$)/.test(line)) continue;
    const uri = /URI="([^"]+)"/.exec(line)?.[1];
    if (!uri) continue;
    renditions.push({
      group: /GROUP-ID="([^"]*)"/.exec(line)?.[1] ?? '',
      uri,
      isDefault: /(?:^|,)\s*DEFAULT=YES(?:,|$)/.test(line),
      itag: Number(/\/itag\/(\d+)\//.exec(uri)?.[1] ?? 0),
    });
  }
  return renditions;
}

/** The best audio rendition: the default group when it exists, then the highest itag (140's AAC over 139's). */
function chooseHlsAudio(master: string): string | null {
  const renditions = hlsAudioRenditions(master);
  if (!renditions.length) return null;
  const defaults = renditions.filter((r) => r.isDefault);
  const pool = defaults.length ? defaults : renditions;
  const numericGroup = (group: string) => (/^\d+$/.test(group) ? Number(group) : 0);
  return [...pool].sort((a, b) => b.itag - a.itag || numericGroup(b.group) - numericGroup(a.group))[0]!.uri;
}

/** Whether an m3u8 URI already points at the relay (`/api/media?url=…`), as rewritten playlists do. */
function isRelayedMediaUrl(value: string, base: string): boolean {
  try {
    const url = new URL(value, base);
    const relay = new URL(base);
    return url.origin === relay.origin && url.pathname === relay.pathname;
  } catch {
    return false;
  }
}

export class PortableSupersededError extends Error {
  override readonly name = 'SupersededError';
}

/** The fields of an adaptive format this engine reads (youtubei.js keeps `Format` internal). */
interface AudioFormat {
  itag?: number;
  mime_type?: string;
  bitrate?: number;
  approx_duration_ms?: string | number;
  has_audio?: boolean;
  has_video?: boolean;
  url?: string;
  signature_cipher?: string;
  cipher?: string;
  decipher(player: unknown): Promise<string>;
}

/** AAC first: every browser decodes it, and iOS plays it in a plain <audio>. The best bitrate wins, as a player would. */
function audioFormat(info: YT.VideoInfo): AudioFormat | undefined {
  const formats = (info.streaming_data?.adaptive_formats ?? []) as unknown as AudioFormat[];
  const usable = formats.filter((f) => f.has_audio && !f.has_video && (f.url || f.signature_cipher || f.cipher));
  const best = (list: AudioFormat[]) => [...list].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  return (
    best(usable.filter((f) => /^audio\/mp4/.test(f.mime_type ?? ''))) ??
    best(usable.filter((f) => /opus/.test(f.mime_type ?? ''))) ??
    best(usable)
  );
}

function codecName(mime: string | undefined): string | null {
  if (!mime) return null;
  if (mime.includes('mp4a')) return 'AAC';
  if (mime.includes('opus')) return 'Opus';
  if (mime.includes('ec-3')) return 'E-AC-3';
  return mime.split(';')[0] ?? null;
}

export class PortableEngine implements PlaybackEngine {
  readonly audio: HTMLAudioElement;
  private yt: Innertube | null = null;
  private generation = 0;
  private current: string | null = null;

  onFatal: (videoId: string, message: string, permanent: boolean) => void = () => {};
  onRecovered: (track: LoadedTrack) => void = () => {};

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
    // The relay serves the file from our own origin, so the element needs no
    // crossOrigin attribute; adding one would only force a CORS round trip.
    this.audio.preload = 'auto';
  }

  /** Nothing to warm beyond the InnerTube session, which the first load builds. */
  async warm(): Promise<void> {
    this.yt ??= await getInnertube();
  }

  async load(videoId: string, { startSec = 0, autoplay = true } = {}): Promise<LoadedTrack> {
    const generation = ++this.generation;
    const started = performance.now();
    trackLog.i(`portable: loading at ${startSec.toFixed(1)}s`, videoId);
    this.yt ??= await getInnertube();

    let lastError: unknown = null;
    for (const client of PORTABLE_CLIENTS) {
      this.checkCurrent(generation);
      try {
        const resolved = await this.resolve(client, videoId);
        this.checkCurrent(generation);
        // Safari's native HLS gives an iPhone the right duration and starts
        // on the first segment. Chrome and Android have no native HLS (and
        // hls.js can't demux YouTube's packed ADTS audio), so they stay on the
        // progressive file.
        if (supportsHls(this.audio)) {
          try {
            const hls = await this.hlsSource(resolved.info);
            if (hls) {
              const track = await this.start(resolved, startSec, autoplay, generation, hls, 'HLS');
              trackLog.i(`portable: playing ${track.format} via ${client} after ${Math.round(performance.now() - started)}ms`, videoId);
              return track;
            }
          } catch (error) {
            if (error instanceof PortableSupersededError) throw error;
            trackLog.w(`portable: HLS didn't start (${describe(error)}); trying the progressive file`, videoId);
            this.checkCurrent(generation);
          }
        }
        const track = await this.start(resolved, startSec, autoplay, generation);
        trackLog.i(`portable: playing ${track.format} via ${client} after ${Math.round(performance.now() - started)}ms`, videoId);
        return track;
      } catch (error) {
        if (error instanceof PortableSupersededError) throw error;
        lastError = error;
        trackLog.w(`portable: ${client} couldn't play it: ${describe(error)}`, videoId);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('This track could not be played.');
  }

  /** One player request for [client], as that client's own app would make it. */
  private async resolve(client: PortableClient, videoId: string): Promise<{ info: YT.VideoInfo; url: string; client: PortableClient }> {
    const yt = this.yt!;
    const { YT, Utils } = await import('youtubei.js/web');
    const response = await yt.actions.execute('/player', {
      videoId,
      client,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: { signatureTimestamp: yt.session.player?.signature_timestamp },
      },
    });
    const info = new YT.VideoInfo([response], yt.actions, Utils.generateRandomString(16));
    const status = info.playability_status?.status;
    const reason = info.playability_status?.reason ?? status ?? 'no status';
    if (status !== 'OK') throw new Error(permanentReason(reason) ?? reason);
    const format = audioFormat(info);
    if (!format) throw new Error('No audio stream in the answer.');
    // The URL's signature and `n` throttle are ciphered; the player script deciphers both.
    const url = await format.decipher(yt.session.player);
    return { info, url, client };
  }

  /**
   * The audio media playlist for this response, fetched through the relay.
   * The master lists renditions only, and both of YouTube's audio groups say
   * `DEFAULT=YES`, so choose the best one ourselves (140 over 139) rather
   * than letting native HLS pick arbitrarily.
   */
  private async hlsSource(info: YT.VideoInfo): Promise<string | null> {
    const manifest = info.streaming_data?.hls_manifest_url;
    if (!manifest) return null;
    const relayed = relayedMediaUrl(manifest);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HLS_TIMEOUT_MS);
    try {
      const response = await fetch(relayed, { signal: controller.signal });
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      const master = await response.text();
      const audio = chooseHlsAudio(master);
      // A response without #EXT-X-MEDIA may already be a media playlist.
      if (!audio) return /#EXTINF:/.test(master) ? relayed : null;
      const base = new URL(relayed);
      const child = new URL(audio, base).toString();
      // The relay rewrites child URLs to /api/media; an unrewritten absolute
      // googlevideo URL is still signed to this egress and must be wrapped.
      return isRelayedMediaUrl(child, base.toString()) ? child : relayedMediaUrl(child);
    } finally {
      clearTimeout(timer);
    }
  }

  private async start(
    resolved: { info: YT.VideoInfo; url: string; client: PortableClient },
    startSec: number,
    autoplay: boolean,
    generation: number,
    source?: string,
    transport: 'HLS' | 'progressive' = 'progressive',
  ): Promise<LoadedTrack> {
    const { info, url, client } = resolved;
    const videoId = info.basic_info.id ?? this.current ?? '';
    this.current = videoId;

    // Every range request goes to the relay, which fetches it from the IP the
    // URL was minted for (the relay's own), so seeking works like a local file.
    this.audio.src = source ?? relayedMediaUrl(url);
    this.audio.load();
    await this.seekTo(startSec, generation);
    if (autoplay) {
      await this.audio.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          trackLog.w('portable: autoplay blocked; waiting for a tap', videoId);
          return;
        }
        throw error;
      });
    }
    await this.firstAudio(generation);

    const basic = info.basic_info;
    const format = audioFormat(info);
    const stats: StreamStats = {
      codec: codecName(format?.mime_type),
      itag: format?.itag ? String(format.itag) : null,
      bitrateKbps: format?.bitrate ? Math.round(format.bitrate / 1000) : null,
      sampleRateHz: null,
      channels: null,
      mode: 'direct',
    };
    return {
      videoId,
      title: basic.title ?? '',
      author: basic.author ?? '',
      durationSec: basic.duration ?? Math.round(info.streaming_data?.adaptive_formats[0]?.approx_duration_ms ?? 0) / 1000,
      thumbnails: [...(basic.thumbnail ?? [])]
        .map((t) => ({ url: t.url, width: t.width, height: t.height }))
        .sort((a, b) => b.width - a.width),
      client: client as unknown as LoadedTrack['client'],
      format: `${format?.itag ?? '?'} ${codecName(format?.mime_type) ?? ''} ${stats.bitrateKbps ?? ''}kbps ${transport}`,
      stream: stats,
      loudnessDb: info.player_config?.audio_config?.loudness_db ?? null,
    };
  }

  /** Positions the element once it knows its duration (or straight away for a seek in a loaded track). */
  private async seekTo(startSec: number, generation: number): Promise<void> {
    if (startSec <= 0) return;
    const audio = this.audio;
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      audio.currentTime = startSec;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        audio.currentTime = startSec;
        resolve();
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`no metadata within ${FIRST_AUDIO_TIMEOUT_MS / 1000}s`)), FIRST_AUDIO_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('error', onError);
      };
      const onError = () => fail(new Error('The audio file could not be loaded.'));
      if (generation !== this.generation) return reject(new PortableSupersededError('Replaced by a newer load'));
      audio.addEventListener('loadedmetadata', done, { once: true });
      audio.addEventListener('error', onError, { once: true });
    });
  }

  private firstAudio(generation: number): Promise<void> {
    const audio = this.audio;
    if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        if (generation !== this.generation) reject(new PortableSupersededError('Replaced by a newer load'));
        else resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('The audio file was refused.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no audio within ${FIRST_AUDIO_TIMEOUT_MS / 1000}s`));
      }, FIRST_AUDIO_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener('canplay', done);
        audio.removeEventListener('error', fail);
      };
      audio.addEventListener('canplay', done, { once: true });
      audio.addEventListener('error', fail, { once: true });
    });
  }

  private checkCurrent(generation: number) {
    if (generation !== this.generation) throw new PortableSupersededError('Replaced by a newer load');
  }

  /** No picture on this path: the artwork stands in (see the class comment). */
  async videoStream(): Promise<VideoStream | null> {
    return null;
  }

  async stop(): Promise<void> {
    this.generation++;
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}

/** Why a playability status is about the track rather than the client, in words the player can show. */
function permanentReason(reason: string): string | null {
  const text = reason.toLowerCase();
  if (/confirm your age|age-restricted|inappropriate for some users|sign in to confirm/.test(text)) {
    return 'This track is age-restricted. Import a YouTube session file from a signed-in browser to play it.';
  }
  if (/country|region/.test(text)) return 'This track isn’t available in your country';
  if (/private/.test(text)) return 'This track is private';
  if (/terminated/.test(text)) return 'The channel behind this track was terminated';
  if (/premium/.test(text)) return 'This track needs YouTube Music Premium';
  return null;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
