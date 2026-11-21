import { needsSpace, type LyricLine } from '@/lyrics/model';
import type { LyricsResult } from '@/lyrics/repository';
import { artworkAtPixels } from '@/lib/artwork';
import { meshPalette, type Rgb } from '@/lib/meshPalette';
import { getDuration, getPlayhead, usePlayer } from '@/state/player';

/**
 * Lyrics in the system's Picture-in-Picture window.
 *
 * Desktop Chrome/Edge have the Document Picture-in-Picture API, but phones
 * don't. Both Android Chrome and iOS Safari do have video PiP, so the lyrics
 * are drawn onto a canvas and captured into a muted <video>. The music keeps
 * playing from the player's own audio element.
 *
 * Safari needs three things the desktop path doesn't:
 * - the PiP video has to stay on screen, if only as a 16×9 tile: it stops
 *   decoding a completely hidden or off-screen video;
 * - the canvas must already hold frames before captureStream();
 * - PiP support is only advertised once the video plays, so it is polled.
 */

type PipVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: 'picture-in-picture') => boolean;
  webkitSetPresentationMode?: (mode: 'picture-in-picture' | 'inline' | 'fullscreen') => void;
  webkitPresentationMode?: 'inline' | 'picture-in-picture' | 'fullscreen';
};

type PipSupport = 'standard' | 'webkit';

export interface LyricsPipSession {
  close: () => void;
}

const FONT = "'BitChord SF Pro Display', 'DM Sans', system-ui, sans-serif";
const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 1280;
const PAD = 56;
const ART_SIZE = 112;
const BAR_Y = CANVAS_HEIGHT - 76;
/** The lyric column: from below the header to just above the progress bar. */
const LYRICS_TOP = 242;
const LYRICS_BOTTOM = CANVAS_HEIGHT - 150;
const ACTIVE_SIZE = 42;
const OTHER_SIZE = 26;
const ACTIVE_LINE_HEIGHT = 54;
const OTHER_LINE_HEIGHT = 35;
const ACTIVE_GAP = 20;
const OTHER_GAP = 6;
const MAX_ROWS = 24;

const isIos = (): boolean =>
  /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isSafari = (): boolean =>
  isIos() || /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

function isIosStandalone(): boolean {
  if (!isIos()) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

function pipSupport(): PipSupport | null {
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') return null;
  const proto = HTMLVideoElement.prototype as PipVideo;
  if (typeof proto.webkitSetPresentationMode === 'function') return 'webkit';
  if (document.pictureInPictureEnabled && typeof proto.requestPictureInPicture === 'function') {
    return 'standard';
  }
  return null;
}

/** Whether this browser has a PiP API the canvas-backed video can use. */
export function canUseLyricsPip(): boolean {
  return pipSupport() !== null;
}

/**
 * Why PiP won't start here, when it is known before the attempt. iPhone Home
 * Screen apps are WebKit but don't get the presentation-mode API at all, and
 * no page can work around that.
 */
export function lyricsPipIssue(): string | null {
  if (isIosStandalone()) {
    return 'Picture-in-Picture is not available in the Home Screen app. Open BitChord in Safari.';
  }
  if (!pipSupport()) return 'This browser does not support Picture-in-Picture.';
  return null;
}

/** Starts the PiP window. Returns null when the browser refuses it. */
export async function startLyricsPip(
  getLyrics: () => LyricsResult | null,
  onEnd: (reason?: string) => void,
): Promise<LyricsPipSession | null> {
  const support = pipSupport();
  if (!support || lyricsPipIssue()) return null;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Prime the canvas before captureStream(): Safari drops a stream whose
  // canvas has no frames, and the first one is sometimes black.
  const draw = () => drawLyrics(ctx, getLyrics());
  draw();
  draw();
  draw();
  if (import.meta.env.DEV) {
    Object.assign(window, { __bcLyricsPipCanvas: canvas });
  }

  const video = document.createElement('video') as PipVideo;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  video.disablePictureInPicture = false;
  // Safari pauses decoding for a video that is off-screen or invisible, so
  // leave a barely visible tile in the corner while the PiP window is open.
  video.style.cssText =
    'position:fixed;right:4px;bottom:calc(env(safe-area-inset-bottom, 0px) + 4px);' +
    'width:16px;height:9px;opacity:0.01;pointer-events:none;z-index:2147483647;object-fit:cover;';
  document.body.append(video);
  if (import.meta.env.DEV) Object.assign(window, { __bcLyricsPipVideo: video });

  let stream: MediaStream | null = null;
  let timer = 0;
  let stopTicker: (() => void) | null = null;
  let closed = false;
  let ended = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(timer);
    stopTicker?.();
    stream?.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
    video.remove();
  };
  const finish = (reason?: string) => {
    if (ended) return;
    ended = true;
    cleanup();
    onEnd(reason);
  };

  const nudge = () => {
    // iOS pauses an inline video when the page goes to the background. It
    // still lets a muted video play, and PiP is what keeps the page alive.
    if (video.paused && !closed) void video.play().catch(() => undefined);
  };

  const tick = () => {
    draw();
    nudge();
  };

  try {
    stream = canvas.captureStream(30);
    if (!stream?.getVideoTracks().length) {
      finish('Picture-in-Picture could not capture the lyrics.');
      return null;
    }
    video.srcObject = stream;
    video.addEventListener('leavepictureinpicture', () => finish());
    video.addEventListener('webkitpresentationmodechanged', () => {
      if (video.webkitPresentationMode !== 'picture-in-picture') finish();
    });

    // A timer keeps the stream moving; Safari additionally needs a clock the
    // background cannot throttle, which is what the silent audio ticker is.
    timer = window.setInterval(tick, isSafari() ? 500 : 100);
    stopTicker = startDrawTicker(tick);

    // Don't await play(): PiP entry has to stay in the click's activation.
    void video.play().catch(() => undefined);

    if (support === 'standard') {
      await enterStandard(video);
    } else {
      pollWebkitPip(video, tick, () => {
        finish('Picture-in-Picture did not start. Open BitChord in Safari and try again.');
      });
    }

    return {
      close: () => {
        closePictureInPicture(video);
        finish();
      },
    };
  } catch {
    finish('Picture-in-Picture could not start.');
    return null;
  }
}

/**
 * A silent ScriptProcessorNode is the one clock Safari does not throttle when
 * the page is in the background. It also keeps the captured video fed while
 * another app is in front.
 */
function startDrawTicker(draw: () => void): (() => void) | null {
  if (!isSafari()) return null;
  try {
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return null;
    const audio = new AudioCtx();
    const node = audio.createScriptProcessor(2048, 1, 1);
    const silence = audio.createGain();
    silence.gain.value = 0;
    node.connect(silence);
    silence.connect(audio.destination);
    let last = 0;
    node.onaudioprocess = () => {
      const now = performance.now();
      if (now - last < 80) return;
      last = now;
      draw();
    };
    void audio.resume().catch(() => undefined);
    return () => {
      node.onaudioprocess = null;
      node.disconnect();
      silence.disconnect();
      void audio.close().catch(() => undefined);
    };
  } catch {
    return null;
  }
}

async function enterStandard(video: PipVideo): Promise<void> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 750);
      video.addEventListener(
        'loadedmetadata',
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  }
  await video.requestPictureInPicture();
}

function pollWebkitPip(video: PipVideo, draw: () => void, fail: () => void): void {
  let attempt = 0;
  const tryEnter = () => {
    if (video.webkitPresentationMode === 'picture-in-picture') return;
    try {
      if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
        video.webkitSetPresentationMode?.('picture-in-picture');
        return;
      }
    } catch {
      // Support is only advertised once a frame has played; keep trying.
    }
    if (++attempt >= 40) {
      fail();
      return;
    }
    draw();
    window.setTimeout(tryEnter, 100);
  };
  tryEnter();
}

function closePictureInPicture(video: PipVideo): void {
  try {
    if (video.webkitPresentationMode === 'picture-in-picture') {
      video.webkitSetPresentationMode?.('inline');
    }
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture();
    }
  } catch {
    // The window was already closed by the system.
  }
}

// ---- Backdrop -------------------------------------------------------------------------

interface Backdrop {
  canvas: HTMLCanvasElement;
  ready: boolean;
}

const backdrops = new Map<string, Backdrop>();
const covers = new Map<string, HTMLImageElement>();

/**
 * The artwork averaged into a soft mesh, as the now-playing screen does. It is
 * rendered once per sleeve at 180×320 and stretched, so the PiP paint loop
 * stays cheap; the canvas' own smoothing is the blur.
 */
function backdropFor(url: string | null): HTMLCanvasElement | null {
  if (!url) return null;
  const known = backdrops.get(url);
  if (known) return known.canvas;

  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 320;
  const entry: Backdrop = { canvas, ready: false };
  backdrops.set(url, entry);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  paintFallback(ctx, canvas.width, canvas.height, null);
  void meshPalette(url)
    .then((cells) => {
      paintMesh(ctx, canvas.width, canvas.height, cells);
      entry.ready = true;
    })
    .catch(() => undefined);
  if (backdrops.size > 8) {
    const oldest = backdrops.keys().next().value;
    if (oldest && oldest !== url) backdrops.delete(oldest);
  }
  return canvas;
}

function paintFallback(ctx: CanvasRenderingContext2D, w: number, h: number, cells: Rgb[] | null): void {
  const base = cells ? average(cells) : ([38, 38, 44] as Rgb);
  ctx.fillStyle = `rgb(${base[0]} ${base[1]} ${base[2]})`;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.5, 0, 0, w * 0.5, h * 0.75, Math.max(w, h));
  glow.addColorStop(0, 'rgba(255,255,255,0.13)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

function paintMesh(ctx: CanvasRenderingContext2D, w: number, h: number, cells: Rgb[]): void {
  paintFallback(ctx, w, h, cells);
  const side = Math.max(w, h);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const [r, g, b] = cells[row * 4 + col] ?? [30, 30, 34];
      const x = ((col + 0.5) / 4) * w;
      const y = ((row + 0.5) / 4) * h;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, side * 0.72);
      glow.addColorStop(0, `rgba(${r},${g},${b},0.72)`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.fillStyle = 'rgba(4,4,7,0.35)';
  ctx.fillRect(0, 0, w, h);
}

function average(cells: Rgb[]): Rgb {
  const sum = cells.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
  return sum.map((v) => v / cells.length) as Rgb;
}

function coverFor(url: string | null): HTMLImageElement | null {
  if (!url) return null;
  const known = covers.get(url);
  if (known) return known.complete && known.naturalWidth ? known : null;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  image.src = artworkAtPixels(url, 226);
  covers.set(url, image);
  if (covers.size > 16) {
    const oldest = covers.keys().next().value;
    if (oldest && oldest !== url) covers.delete(oldest);
  }
  return null;
}

// ---- Drawing --------------------------------------------------------------------------

function drawLyrics(ctx: CanvasRenderingContext2D, result: LyricsResult | null): void {
  const w = CANVAS_WIDTH;
  const h = CANVAS_HEIGHT;
  const now = usePlayer.getState().nowPlaying;
  const head = getPlayhead();

  ctx.save();
  ctx.textBaseline = 'middle';

  const backdrop = backdropFor(now?.artworkUrl ?? null);
  if (backdrop) ctx.drawImage(backdrop, 0, 0, w, h);
  else paintFallback(ctx, w, h, null);

  // The page's dark scrim: dense enough for white type, still showing the sleeve.
  const scrim = ctx.createLinearGradient(0, 0, 0, h);
  scrim.addColorStop(0, 'rgba(8,8,11,0.22)');
  scrim.addColorStop(0.3, 'rgba(7,7,10,0.42)');
  scrim.addColorStop(0.58, 'rgba(6,6,9,0.6)');
  scrim.addColorStop(1, 'rgba(4,4,6,0.9)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(w * 0.5, 0, 0, w * 0.5, h * 0.22, w * 0.85);
  glow.addColorStop(0, 'rgba(255,255,255,0.09)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const focus = ctx.createRadialGradient(w * 0.5, h * 0.53, 0, w * 0.5, h * 0.53, w * 0.8);
  focus.addColorStop(0, 'rgba(255,255,255,0.035)');
  focus.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = focus;
  ctx.fillRect(0, 0, w, h);

  drawHeader(ctx, now, result, w);
  drawLines(ctx, result, head?.sec ?? 0, w);

  const bottomFade = ctx.createLinearGradient(0, LYRICS_BOTTOM - 24, 0, LYRICS_BOTTOM + 42);
  bottomFade.addColorStop(0, 'rgba(5,5,8,0)');
  bottomFade.addColorStop(1, 'rgba(5,5,8,0.92)');
  ctx.fillStyle = bottomFade;
  ctx.fillRect(0, LYRICS_BOTTOM - 24, w, 66);

  drawProgress(ctx, head?.sec ?? 0, w, h);
  ctx.restore();
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  now: ReturnType<typeof usePlayer.getState>['nowPlaying'],
  result: LyricsResult | null,
  w: number,
): void {
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.58)';
  ctx.font = `600 19px ${FONT}`;
  ctx.fillText('Lyrics', w / 2, 46);

  if (result?.label) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(clip(ctx, result.label, 160), w - PAD, 46);
  }

  const x = PAD;
  const y = 78;
  roundedRect(ctx, x, y, ART_SIZE, ART_SIZE, 20);
  ctx.save();
  ctx.clip();
  const cover = coverFor(now?.artworkUrl ?? null);
  if (cover) {
    const scale = Math.max(ART_SIZE / cover.width, ART_SIZE / cover.height);
    const dw = cover.width * scale;
    const dh = cover.height * scale;
    ctx.drawImage(cover, x + (ART_SIZE - dw) / 2, y + (ART_SIZE - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(x, y, ART_SIZE, ART_SIZE);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.font = `500 44px ${FONT}`;
    ctx.fillText('♪', x + ART_SIZE / 2, y + ART_SIZE / 2 + 2);
  }
  ctx.restore();
  roundedRect(ctx, x, y, ART_SIZE, ART_SIZE, 20);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const textX = x + ART_SIZE + 28;
  const textWidth = w - textX - PAD;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.98)';
  ctx.font = `700 32px ${FONT}`;
  ctx.fillText(clip(ctx, now?.title || 'BitChord', textWidth), textX, 112);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(clip(ctx, now?.artist || 'Lyrics', textWidth), textX, 152);

  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, 224);
  ctx.lineTo(w - PAD, 224);
  ctx.stroke();
}

function drawLines(ctx: CanvasRenderingContext2D, result: LyricsResult | null, sec: number, w: number): void {
  const lines = result?.lines ?? [];
  const currentMs = sec * 1000;
  ctx.textAlign = 'center';

  if (!lines.length) {
    const center = (LYRICS_TOP + LYRICS_BOTTOM) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.68)';
    ctx.font = `500 26px ${FONT}`;
    ctx.fillText(result ? 'No lyrics' : 'Loading lyrics…', w / 2, center);
    return;
  }

  const active = activeLine(lines, currentMs);
  const rows = active >= 0 ? rowsAround(ctx, lines, active, w) : openingRows(ctx, lines, w);
  if (!rows.length) return;
  const height = blockHeight(rows);
  let y = blockTop(rows, lines.length, height);

  // The column is deliberately clipped: the lyric area owns the whole space
  // between the header and the progress bar, with no dead band in the middle.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, LYRICS_TOP - 2, w, LYRICS_BOTTOM - LYRICS_TOP + 4);
  ctx.clip();

  for (const row of rows) {
    const font = `${row.weight} ${row.size}px ${FONT}`;
    for (const segment of row.segments) {
      drawSegment(
        ctx,
        segment,
        w / 2,
        y + row.lineHeight / 2,
        font,
        row.isActive
          ? row.timed.times.length
            ? 'rgba(255,255,255,0.55)'
            : 'rgba(255,255,255,0.98)'
          : `rgba(255,255,255,${row.opacity})`,
        row.isActive ? row.timed : null,
        currentMs,
        row.isActive,
      );
      y += row.lineHeight;
    }
    y += row.gap;
  }
  ctx.restore();
}

interface RenderRow {
  index: number;
  isActive: boolean;
  size: number;
  weight: number;
  lineHeight: number;
  timed: TimedText;
  segments: Segment[];
  height: number;
  gap: number;
  opacity: number;
}

/**
 * Fills the whole lyric column around the active line. Rows are added on both
 * sides until the next one would reach the progress bar, so a PiP window is
 * lyrics first rather than nine lines floating in empty space.
 */
function rowsAround(ctx: CanvasRenderingContext2D, lines: LyricLine[], active: number, w: number): RenderRow[] {
  const span = LYRICS_BOTTOM - LYRICS_TOP;
  const chosen = new Map<number, RenderRow>();
  chosen.set(active, buildRow(ctx, lines, active, active, w));
  let before = active - 1;
  let after = active + 1;

  while (chosen.size < MAX_ROWS) {
    let progressed = false;
    for (const side of ['after', 'before'] as const) {
      const index = side === 'after' ? after : before;
      if (index < 0 || index >= lines.length) continue;
      const row = buildRow(ctx, lines, index, active, w);
      const next = [...chosen.values(), row].sort((a, b) => a.index - b.index);
      if (blockHeight(next) > span) continue;
      chosen.set(index, row);
      if (side === 'after') after++;
      else before--;
      progressed = true;
    }
    if (!progressed) break;
  }

  return [...chosen.values()].sort((a, b) => a.index - b.index);
}

/** Before the first timed line: fill from the top with the opening lyrics. */
function openingRows(ctx: CanvasRenderingContext2D, lines: LyricLine[], w: number): RenderRow[] {
  const span = LYRICS_BOTTOM - LYRICS_TOP;
  const rows: RenderRow[] = [];
  for (let index = 0; index < lines.length && rows.length < MAX_ROWS; index++) {
    const row = buildRow(ctx, lines, index, -1, w);
    if (blockHeight([...rows, row]) > span) break;
    rows.push(row);
  }
  return rows;
}

function buildRow(
  ctx: CanvasRenderingContext2D,
  lines: LyricLine[],
  index: number,
  active: number,
  w: number,
): RenderRow {
  const line = lines[index]!;
  const isActive = index === active;
  const size = isActive ? ACTIVE_SIZE : OTHER_SIZE;
  const weight = isActive ? 700 : 500;
  const lineHeight = isActive ? ACTIVE_LINE_HEIGHT : OTHER_LINE_HEIGHT;
  const timed = timedText(line);
  const segments = wrapSegments(ctx, timed.text, w - PAD * 2, `${weight} ${size}px ${FONT}`, 2);
  return {
    index,
    isActive,
    size,
    weight,
    lineHeight,
    timed,
    segments,
    height: segments.length * lineHeight,
    gap: isActive ? ACTIVE_GAP : OTHER_GAP,
    opacity: isActive ? 1 : distanceOpacity(index - active),
  };
}

function blockHeight(rows: RenderRow[]): number {
  return rows.reduce((sum, row, index) => sum + row.height + (index < rows.length - 1 ? row.gap : 0), 0);
}

function blockTop(rows: RenderRow[], lineCount: number, height: number): number {
  const first = rows[0]!.index;
  const last = rows[rows.length - 1]!.index;
  if (first === 0) return LYRICS_TOP;
  if (last === lineCount - 1) return Math.max(LYRICS_TOP, LYRICS_BOTTOM - height);
  return LYRICS_TOP + Math.max(0, (LYRICS_BOTTOM - LYRICS_TOP - height) / 2);
}

function distanceOpacity(distance: number): number {
  const table = [0.62, 0.44, 0.31, 0.22, 0.16, 0.12];
  return table[Math.min(Math.max(Math.abs(distance) - 1, 0), table.length - 1)] ?? 0.12;
}

interface Wipe {
  kind: 'none' | 'partial' | 'full';
  /** Pixels from the segment's left edge. */
  x: number;
}

/**
 * A soft karaoke edge, like am-lyrics' interpolated highlight: the current
 * character is filled by how far playback has moved through its word, and the
 * edge itself is a short gradient rather than a hard character slice.
 */
function drawSegment(
  ctx: CanvasRenderingContext2D,
  segment: Segment,
  centerX: number,
  y: number,
  font: string,
  base: string,
  timed: TimedText | null,
  currentMs: number,
  glow: boolean,
): void {
  ctx.font = font;
  ctx.textAlign = 'left';
  const width = ctx.measureText(segment.text).width;
  const x = centerX - width / 2;
  ctx.save();
  if (glow) {
    ctx.shadowColor = 'rgba(255,255,255,0.18)';
    ctx.shadowBlur = 18;
  }
  ctx.fillStyle = base;
  ctx.fillText(segment.text, x, y);
  ctx.restore();

  if (!timed?.times.length) return;
  const wipe = wipeAt(ctx, segment, timed, currentMs);
  if (wipe.kind === 'none') return;
  if (wipe.kind === 'full') {
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillText(segment.text, x, y);
    return;
  }

  const edge = x + wipe.x;
  const soft = 22;
  const gradient = ctx.createLinearGradient(edge - soft, 0, edge + soft, 0);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.38, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillText(segment.text, x, y);
}

function wipeAt(
  ctx: CanvasRenderingContext2D,
  segment: Segment,
  timed: TimedText,
  currentMs: number,
): Wipe {
  const from = segment.from;
  const to = Math.min(segment.to, segment.from + segment.text.length, timed.times.length);
  if (from >= to) return { kind: 'none', x: 0 };

  const first = timed.times[from];
  if (first === undefined || currentMs <= first) return { kind: 'none', x: 0 };
  const lastEnd = timed.ends[to - 1];
  if (lastEnd === undefined || currentMs >= lastEnd) return { kind: 'full', x: 0 };

  for (let i = from; i < to; i++) {
    const start = timed.times[i];
    const end = timed.ends[i];
    if (start === undefined || end === undefined) break;
    const offset = i - from;
    const before = ctx.measureText(segment.text.slice(0, offset)).width;
    if (currentMs >= end) continue;
    if (currentMs >= start) {
      const progress = end > start ? Math.min(1, Math.max(0, (currentMs - start) / (end - start))) : 1;
      const width = ctx.measureText(segment.text.slice(offset, offset + 1)).width;
      return { kind: 'partial', x: before + width * progress };
    }
    return { kind: 'partial', x: before };
  }
  return { kind: 'full', x: 0 };
}

function drawProgress(ctx: CanvasRenderingContext2D, sec: number, w: number, h: number): void {
  const duration = getDuration();
  const progress = duration > 0 ? Math.min(1, Math.max(0, sec / duration)) : 0;
  const x = PAD;
  const width = w - PAD * 2;

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  roundedRect(ctx, x, BAR_Y, width, 4, 2);
  ctx.fill();
  if (progress > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    roundedRect(ctx, x, BAR_Y, Math.max(4, width * progress), 4, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + width * progress, BAR_Y + 2, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = `500 17px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(formatTime(sec), x, h - 44);
  if (duration > 0) {
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(duration), w - PAD, h - 44);
  }
}

// ---- Lyrics layout --------------------------------------------------------------------

interface TimedText {
  text: string;
  times: number[];
  ends: number[];
}

interface Segment {
  text: string;
  from: number;
  to: number;
}

function activeLine(lines: LyricLine[], timeMs: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.timeMs <= timeMs) active = i;
    else break;
  }
  return active;
}

/** The line's text and, where the provider timed words, each character's interval. */
function timedText(line: LyricLine): TimedText {
  const words = line.words;
  if (!words.length) return { text: line.text || '♪', times: [], ends: [] };
  let text = '';
  const times: number[] = [];
  const ends: number[] = [];
  for (let w = 0; w < words.length; w++) {
    const word = words[w]!;
    if (w > 0 && needsSpace(words[w - 1]!, word)) {
      text += ' ';
      times.push(word.startMs);
      ends.push(word.startMs);
    }
    const chars = [...word.text];
    const span = Math.max(1, word.endMs - word.startMs);
    for (let c = 0; c < chars.length; c++) {
      text += chars[c]!;
      times.push(word.startMs + (span * c) / chars.length);
      ends.push(word.startMs + (span * (c + 1)) / chars.length);
    }
  }
  return { text: text || line.text || '♪', times, ends };
}

/**
 * Wraps a line into at most [maxLines] pieces, keeping each piece's character
 * range so the karaoke wipe can be clipped to the sung part. Latin text breaks
 * at a space; Japanese and Chinese break per character.
 */
function wrapSegments(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
  maxLines: number,
): Segment[] {
  ctx.font = font;
  if (!text) return [{ text: '♪', from: 0, to: 0 }];
  const out: Segment[] = [];
  let start = 0;
  let lastSpace = -1;
  let i = 0;
  while (i < text.length && out.length < maxLines) {
    const candidate = text.slice(start, i + 1);
    if (ctx.measureText(candidate).width > maxWidth && i > start) {
      let breakAt = lastSpace > start ? lastSpace : i;
      if (breakAt <= start) breakAt = i;
      out.push({ text: text.slice(start, breakAt).trimEnd(), from: start, to: breakAt });
      start = breakAt;
      while (start < text.length && text[start] === ' ') start++;
      lastSpace = -1;
      i = start;
      continue;
    }
    if (text[i] === ' ') lastSpace = i;
    i++;
  }
  if (out.length < maxLines && start < text.length) {
    out.push({ text: text.slice(start).trimEnd(), from: start, to: text.length });
  }
  if (out.length === maxLines && start < text.length) {
    const last = out[out.length - 1]!;
    last.text = ellipsize(ctx, `${last.text}…`, maxWidth);
  }
  return out;
}

// ---- Small canvas helpers -------------------------------------------------------------

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  return ellipsize(ctx, text, maxWidth);
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
