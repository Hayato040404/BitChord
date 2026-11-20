import type { LyricLine } from '@/lyrics/model';
import type { LyricsResult } from '@/lyrics/repository';
import { getDuration, getPlayhead, usePlayer } from '@/state/player';

/**
 * Lyrics in the system's Picture-in-Picture window.
 *
 * Desktop Chrome/Edge have the Document Picture-in-Picture API, but phones
 * don't. Both Android Chrome and iOS Safari do have video PiP, so the lyrics
 * are drawn onto a canvas and captured into a muted <video>: the same trick
 * the picture-in-picture spec uses for canvas content. The music keeps
 * playing from the player's own audio element.
 */

type PipVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: 'picture-in-picture') => boolean;
  webkitSetPresentationMode?: (mode: 'picture-in-picture' | 'inline' | 'fullscreen') => void;
  webkitPresentationMode?: 'inline' | 'picture-in-picture' | 'fullscreen';
};

export interface LyricsPipSession {
  close: () => void;
}

const FONT = "'BitChord SF Pro Display', 'DM Sans', system-ui, sans-serif";
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 720;

/** Whether this browser has a PiP API a canvas-backed video can use. */
export function canUseLyricsPip(): boolean {
  if (typeof document === 'undefined') return false;
  const video = document.createElement('video') as PipVideo;
  return typeof video.requestPictureInPicture === 'function' || typeof video.webkitSetPresentationMode === 'function';
}

/** Starts the PiP window. Returns null when the browser refuses it. */
export async function startLyricsPip(
  getLyrics: () => LyricsResult | null,
  onEnd: () => void,
): Promise<LyricsPipSession | null> {
  if (!canUseLyricsPip() || typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (import.meta.env.DEV) Object.assign(window, { __bcLyricsPipCanvas: canvas });

  const video = document.createElement('video') as PipVideo;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(video);

  const draw = () => drawLyrics(ctx, getLyrics());
  // Safari needs a frame on the canvas before captureStream() will carry it.
  draw();
  draw();

  let stream: MediaStream | null = null;
  let timer = 0;
  let closed = false;
  let ended = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
    video.remove();
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    cleanup();
    onEnd();
  };

  try {
    stream = canvas.captureStream(30);
    video.srcObject = stream;
    video.addEventListener('leavepictureinpicture', finish);
    video.addEventListener('webkitpresentationmodechanged', () => {
      if (video.webkitPresentationMode !== 'picture-in-picture') finish();
    });
    timer = window.setInterval(draw, 250);
    // Don't await play(): PiP entry has to stay in the click's activation.
    void video.play().catch(() => undefined);
    await enterPictureInPicture(video);
    return { close: () => closePictureInPicture(video, finish) };
  } catch {
    finish();
    return null;
  }
}

async function enterPictureInPicture(video: PipVideo): Promise<void> {
  if (typeof video.requestPictureInPicture === 'function') {
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
    return;
  }

  // Safari's presentation mode is only advertised once the video can play.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!video.webkitSupportsPresentationMode || video.webkitSupportsPresentationMode('picture-in-picture')) {
      video.webkitSetPresentationMode?.('picture-in-picture');
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error('Picture-in-Picture is not available');
}

function closePictureInPicture(video: PipVideo, finish: () => void) {
  try {
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture();
    } else {
      video.webkitSetPresentationMode?.('inline');
    }
  } catch {
    // The window was already closed by the system.
  }
  finish();
}

function drawLyrics(ctx: CanvasRenderingContext2D, result: LyricsResult | null) {
  const w = CANVAS_WIDTH;
  const h = CANVAS_HEIGHT;
  const now = usePlayer.getState().nowPlaying;

  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, '#212127');
  background.addColorStop(0.55, '#111114');
  background.addColorStop(1, '#08080a');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(w * 0.5, h * 0.18, 0, w * 0.5, h * 0.18, w * 0.8);
  glow.addColorStop(0, 'rgba(255,255,255,0.09)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.56)';
  ctx.font = `600 17px ${FONT}`;
  ctx.fillText(clip(ctx, now?.title || 'BitChord', w - 64), w / 2, 44);
  ctx.fillStyle = 'rgba(255,255,255,0.36)';
  ctx.font = `400 13px ${FONT}`;
  ctx.fillText(clip(ctx, now?.artist || 'Lyrics', w - 64), w / 2, 68);

  const head = getPlayhead();
  const currentMs = (head?.sec ?? 0) * 1000;
  const lines = result?.lines ?? [];
  const active = activeLine(lines, currentMs);
  const rows = visibleRows(lines, active);
  const center = h * 0.53;

  if (!rows.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText(result ? '♪' : 'Loading lyrics…', w / 2, center);
  } else {
    // Lay the block out first so the active line sits in the middle of the
    // window rather than at the top of it.
    const rendered = rows.map((row) => {
      const isActive = row.index === active;
      const size = isActive ? 31 : 20;
      const lineHeight = isActive ? 38 : 28;
      const weight = isActive ? 600 : 500;
      const wrapped = wrap(ctx, row.line.text || '♪', w - 100, `${weight} ${size}px ${FONT}`, lineHeight).slice(
        0,
        isActive ? 2 : 1,
      );
      return { isActive, lineHeight, wrapped, gap: isActive ? 30 : 18, weight, size };
    });
    const total = rendered.reduce((sum, row) => sum + row.wrapped.length * row.lineHeight + row.gap, 0);
    let y = center - total / 2;
    for (const row of rendered) {
      ctx.font = `${row.weight} ${row.size}px ${FONT}`;
      ctx.fillStyle = row.isActive ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.42)';
      for (const text of row.wrapped) {
        ctx.fillText(text, w / 2, y + row.lineHeight / 2);
        y += row.lineHeight;
      }
      y += row.gap;
    }
  }

  const duration = getDuration();
  const progress = duration > 0 ? Math.min(1, Math.max(0, (head?.sec ?? 0) / duration)) : 0;
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(64, h - 48, w - 128, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillRect(64, h - 48, (w - 128) * progress, 3);
}

function activeLine(lines: LyricLine[], timeMs: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.timeMs <= timeMs) active = i;
    else break;
  }
  return active;
}

function visibleRows(lines: LyricLine[], active: number): { index: number; line: LyricLine }[] {
  if (!lines.length) return [];
  const start = Math.max(0, active - 2);
  const end = Math.min(lines.length, Math.max(active + 3, start + 5));
  const rows: { index: number; line: LyricLine }[] = [];
  for (let i = start; i < end; i++) rows.push({ index: i, line: lines[i]! });
  return rows;
}

/** Wraps a lyric line into at most two lines: at a space for Latin text, per character for Japanese. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string, lineHeight: number): string[] {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const out: string[] = [];
  let line = '';
  let lastSpace = -1;
  for (const character of text) {
    const next = line + character;
    if (line && ctx.measureText(next).width > maxWidth) {
      if (lastSpace > 0) {
        // A word was in progress: end the line before it and carry it over.
        out.push(line.slice(0, lastSpace).trimEnd());
        line = (line.slice(lastSpace + 1) + character).trimStart();
        lastSpace = line.lastIndexOf(' ');
      } else {
        out.push(line.trimEnd());
        line = character.trimStart();
      }
      if (out.length === 2) break;
    } else {
      line = next;
      if (character === ' ') lastSpace = line.length - 1;
    }
  }
  if (line && out.length < 2) out.push(line.trimEnd());
  return out;
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}
