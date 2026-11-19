import { ChevronDown, Loader2, MoreHorizontal, ThumbsDown, ThumbsUp } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, BackwardIcon, ForwardIcon, ShuffleIcon, RepeatIcon, RepeatOneIcon, LyricsIcon, LyricsActiveIcon, UpNextIcon } from '@/components/icons/Transport';
import { ExplicitBadge } from '@/components/music/ExplicitBadge';
import { TrackMenu } from '@/components/music/TrackMenu';
import { albumHref } from '@/components/music/links';
import { useLikeStatus, useSetLiked, useSignedIn } from '@/data/music/queries';
import type { Track } from '@/data/music/types';
import { useTrackMotion } from '@/data/apple/motionArt';
import { sizedArtwork } from '@/lib/artwork';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { Credits, PageLink } from './Lcd';
import { MeshBackdrop } from './MeshBackdrop';
import { albumPageFor } from './nowPlayingLinks';
import { UpNext } from './UpNext';
import { useScrubber } from './useScrubber';

const LyricsPanel = lazy(() => import('./LyricsPanel').then((m) => ({ default: m.LyricsPanel })));

/** How far down the sheet must be dragged before letting go closes it. */
const DISMISS_DISTANCE = 120;

/**
 * The phone's now-playing screen (Apple Music's): it slides up over the tab
 * bar and mini player, the artwork large at the top, then the title, artist
 * and album, the seek line and times, the transport, volume, and the row of
 * lyrics, favourite and Up Next. Dragging down anywhere (outside the
 * scrubber) dismisses it; Escape and the chevron close it too.
 *
 * The lyrics and Up Next open as sheets over this one, exactly as Apple's do,
 * and both are its own instances: the desktop's side panel stays out of the
 * way while this is open (AppShell).
 */
export function MobileNowPlaying() {
  const open = useUi((s) => s.nowPlayingOpen);
  const close = useUi((s) => s.setNowPlayingOpen);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const status = usePlayer((s) => s.status);
  const error = usePlayer((s) => s.error);
  const playing = status === 'playing' || status === 'buffering';
  const [panel, setPanel] = useState<'lyrics' | 'queue' | null>(null);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<{ y: number; at: number } | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  // A track that ends the queue closes nothing: Apple's screen stays on the
  // last song, paused, which is the state this one is left in.
  useEffect(() => {
    if (!nowPlaying) close(false);
  }, [nowPlaying, close]);

  useEffect(() => {
    if (!open) setPanel(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (panel) setPanel(null);
      else close(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, panel, close]);

  if (!open || !nowPlaying) return null;

  const dragHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('[data-no-drag], button, a, input')) return;
      dragStart.current = { y: event.clientY, at: performance.now() };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStart.current) return;
      setDrag(Math.max(0, event.clientY - dragStart.current.y));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStart.current) return;
      const distance = Math.max(0, event.clientY - dragStart.current.y);
      const speed = distance / Math.max(1, performance.now() - dragStart.current.at);
      dragStart.current = null;
      setDrag(0);
      if (distance > DISMISS_DISTANCE || (distance > 40 && speed > 0.6)) close(false);
    },
    onPointerCancel: () => {
      dragStart.current = null;
      setDrag(0);
    },
  };

  return (
    <div
      ref={sheet}
      className="fixed inset-0 z-[calc(var(--z-contextual-menus)-2)] isolate animate-enter overflow-hidden text-primary [--art:min(86vw,42dvh,420px)]"
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      data-full-screen
      data-now-playing-sheet
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}
      {...dragHandlers}
    >
      <MeshBackdrop artworkUrl={nowPlaying.artworkUrl} playing={playing} />

      <div className="relative flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {/* The grabber and the chevron, as Apple's sheet. */}
        <div className="flex h-12 flex-none items-center justify-between px-4">
          <button className="grid size-9 place-items-center rounded-full text-secondary" aria-label="Close" onClick={() => close(false)}>
            <ChevronDown size={26} strokeWidth={2.2} />
          </button>
          <span className="h-1 w-9 rounded-full bg-[#ffffff40]" aria-hidden="true" />
          <span className="w-9" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 pb-3">
          <NowPlayingArtwork />
          <div className="mt-[clamp(14px,2.4vh,26px)] flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate type-title-1-emphasized">{nowPlaying.title}</span>
                <QueueTrackExplicit />
              </div>
              <div className="mt-0.5 truncate type-title-3 text-secondary">
                <NowPlayingCredits />
              </div>
            </div>
            <QueueTrackMenu />
          </div>
          {status === 'error' && error && <p className="mt-1.5 type-callout text-key">{error}</p>}
          <SheetScrubber />
          <SheetTransport />
          <VolumeBar />
          <SheetActions panel={panel} setPanel={setPanel} />
        </div>
      </div>

      {panel && (
        // The sheet's own surface, not the page's: this panel sits inside
        // [data-full-screen], whose text is white whatever the page's
        // appearance. `bg-page` is the light page's colour, so the lyrics and
        // Up Next came out white on white. Apple's sheet is a near-opaque
        // dark, dimmed the artwork behind it.
        <div className="absolute inset-0 z-[calc(var(--z-web-chrome)+1)] flex flex-col bg-[rgb(22_22_24/0.96)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-primary [backdrop-filter:blur(40px)_saturate(140%)]">
          <div className="flex h-12 flex-none items-center justify-between px-4">
            <span className="type-title-3-emphasized">{panel === 'lyrics' ? 'Lyrics' : 'Up Next'}</span>
            <button
              className="grid size-9 place-items-center rounded-full text-secondary"
              aria-label={panel === 'lyrics' ? 'Close Lyrics' : 'Close Up Next'}
              onClick={() => setPanel(null)}
            >
              <ChevronDown size={24} strokeWidth={2.2} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === 'lyrics' ? (
              // A spinner while the lyrics chunk loads: null would leave the
              // sheet looking empty for as long as the fetch takes.
              <Suspense fallback={<div className="grid h-40 place-items-center"><Loader2 size={20} className="animate-spin text-secondary" /></div>}>
                <LyricsPanel variant="mobile" />
              </Suspense>
            ) : (
              <UpNext />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The queue's row for what's playing: the menu and the explicit badge need it. */
function useQueueTrack(): Track | null {
  return usePlayer((s) => {
    const entry = s.queue[s.index]?.track;
    return entry && entry.videoId === s.nowPlaying?.videoId ? entry : null;
  });
}

function QueueTrackExplicit() {
  const track = useQueueTrack();
  return track?.explicit ? <ExplicitBadge size={15} /> : null;
}

function QueueTrackMenu() {
  const track = useQueueTrack();
  if (!track) return null;
  return (
    <TrackMenu
      track={track}
      className="grid size-8 flex-none place-items-center rounded-full bg-[#ffffff1a] text-primary"
      placement="above-end"
    />
  );
}

/**
 * The artwork, large and centred: the animated sleeve over the still cover
 * once it plays, as Apple's shows it, with the same scale-on-pause.
 */
function NowPlayingArtwork() {
  const nowPlaying = usePlayer((s) => s.nowPlaying)!;
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const track = useQueueTrack();
  const motion = useTrackMotion(nowPlaying.title, nowPlaying.artist, track?.album?.name);
  return (
    <div className="relative mx-auto w-(--art) flex-none self-center">
      {nowPlaying.artworkUrl && (
        <>
          <img
            className="absolute inset-0 -z-1 translate-y-2 scale-96 rounded-[12px] opacity-40 blur-[20px] saturate-200"
            src={sizedArtwork(nowPlaying.artworkUrl, 60)}
            alt=""
            referrerPolicy="no-referrer"
            decoding="async"
          />
          <img
            key={nowPlaying.artworkUrl}
            className={`aspect-square w-full rounded-[12px] bg-[#ffffff12] object-cover shadow-[0_10px_30px_#00000059] transition-[scale] duration-450 ease-[cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none${playing ? '' : ' scale-92'}`}
            src={sizedArtwork(nowPlaying.artworkUrl, 640)}
            alt=""
            referrerPolicy="no-referrer"
            decoding="async"
          />
        </>
      )}
      {motion && (
        <img
          key={motion.url}
          src={motion.url}
          alt=""
          className="absolute inset-0 size-full rounded-[12px] object-cover opacity-0 transition-opacity duration-600 ease-in data-ready:opacity-100"
          onLoad={(event) => event.currentTarget.setAttribute('data-ready', '')}
        />
      )}
    </div>
  );
}

/** The title's and artist's links, as everywhere else: the title to the album, each name to its artist. */
function NowPlayingCredits() {
  const nowPlaying = usePlayer((s) => s.nowPlaying)!;
  const track = useQueueTrack();
  const album = track?.album ?? null;
  const { videoId, title, artist } = nowPlaying;
  return (
    <>
      {artist && <Credits videoId={videoId} line={artist} artists={track?.artists ?? []} className="text-secondary" />}
      {artist && album?.name && ' — '}
      {album?.name && (
        <PageLink
          className="text-secondary"
          href={albumHref(album.id ?? null)}
          resolve={() => albumPageFor(videoId, album, [title, artist].filter(Boolean).join(' '))}
        >
          {album.name}
        </PageLink>
      )}
    </>
  );
}

/** The seek line, thicker than the pill's, with the times at its ends. */
function SheetScrubber() {
  const { bar, elapsed, remaining, dragging, handlers } = useScrubber();
  return (
    <div className="mt-auto select-none pt-4" data-dragging={dragging || undefined} data-no-drag>
      <div className="group/hit flex h-6 cursor-pointer touch-none items-center" {...handlers}>
        <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-[#ffffff2e]" aria-hidden="true">
          <div ref={bar} className="size-full origin-left scale-x-(--progress) bg-[#ffffffb3] [--progress:0] group-data-dragging/hit:bg-white" />
        </div>
      </div>
      <div className="flex justify-between type-[500_11px/14px] tabular-nums text-tertiary">
        <span ref={elapsed} />
        <span ref={remaining} />
      </div>
    </div>
  );
}

const control = 'grid place-items-center rounded-full text-primary disabled:opacity-35';
const toggle = `${control} size-10 text-tertiary aria-pressed:text-primary`;

/** Shuffle, previous, play/pause, next, repeat, as Apple's large row. */
function SheetTransport() {
  const hasTrack = usePlayer((s) => s.nowPlaying !== null);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const hasNext = usePlayer((s) => s.index + 1 < s.queue.length || s.repeat !== 'off' || (s.autoplay && s.index >= 0));
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const { togglePlay, next, previous, toggleShuffle, cycleRepeat } = usePlayer.getState();
  return (
    <div className="mx-auto flex w-full max-w-[340px] flex-none items-center justify-between pt-1">
      <button className={toggle} aria-label="Shuffle" aria-pressed={shuffle} onClick={toggleShuffle}>
        <ShuffleIcon size={26} />
      </button>
      <button className={`${control} size-12`} disabled={!hasTrack} aria-label="Previous" onClick={previous}>
        <BackwardIcon size={36} />
      </button>
      <button className={`${control} size-16`} disabled={!hasTrack} aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
        {playing ? <PauseIcon size={52} /> : <PlayIcon size={52} />}
      </button>
      <button className={`${control} size-12`} disabled={!hasTrack || !hasNext} aria-label="Next" onClick={next}>
        <ForwardIcon size={36} />
      </button>
      <button
        className={toggle}
        aria-label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
        aria-pressed={repeat !== 'off'}
        onClick={cycleRepeat}
      >
        {repeat === 'one' ? <RepeatOneIcon size={26} /> : <RepeatIcon size={26} />}
      </button>
    </div>
  );
}

/**
 * The volume slider: a plain range input, styled to Apple's bar. The desktop's
 * pill has a hover-revealed slider, which has no place on a touch screen; the
 * phone's iOS volume keys control the element's own volume anyway.
 */
function VolumeBar() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  return (
    <div className="flex flex-none items-center gap-2 pt-3 text-tertiary" data-no-drag>
      <VolumeIcon level={muted ? 0 : volume} />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        aria-label="Volume"
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[#ffffff33] accent-white [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
        onChange={(event) => setVolume(Number(event.target.value))}
      />
      <VolumeIcon level={1} />
    </div>
  );
}

function VolumeIcon({ level }: { level: number }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="flex-none">
      <path d="M8 2.3 5 5H2.5v6H5l3 2.7z" />
      {level > 0 && <path d="M10 5.2a3.5 3.5 0 0 1 0 5.6" fill="none" stroke="currentColor" strokeWidth="1.2" />}
      {level > 0.5 && <path d="M11.7 3.6a5.5 5.5 0 0 1 0 8.8" fill="none" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}

/** Lyrics, favourite, Up Next: Apple's bottom row, with the like controls beside it. */
function SheetActions({ panel, setPanel }: { panel: 'lyrics' | 'queue' | null; setPanel: (panel: 'lyrics' | 'queue' | null) => void }) {
  const videoId = usePlayer((s) => s.nowPlaying?.videoId ?? null);
  return (
    <div className="flex flex-none items-center justify-between pt-3" data-no-drag>
      <button
        className="grid size-9 place-items-center rounded-full text-secondary aria-pressed:text-primary"
        aria-label="Lyrics"
        aria-pressed={panel === 'lyrics'}
        onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}
      >
        {panel === 'lyrics' ? <LyricsActiveIcon size={22} /> : <LyricsIcon size={22} />}
      </button>
      <LikeControls videoId={videoId} />
      <button
        className="grid size-9 place-items-center rounded-full text-secondary aria-pressed:text-primary"
        aria-label="Up Next"
        aria-pressed={panel === 'queue'}
        onClick={() => setPanel(panel === 'queue' ? null : 'queue')}
      >
        <UpNextIcon size={22} />
      </button>
    </div>
  );
}

/** Favourite and unfavourite: Apple's thumbs, shown only when an account is signed in. */
function LikeControls({ videoId }: { videoId: string | null }) {
  const signedIn = useSignedIn();
  const status = useLikeStatus(signedIn ? videoId : null);
  const setLiked = useSetLiked();
  if (!signedIn || !videoId) return <span />;
  const liked = status.data === 'LIKE';
  return (
    <div className="flex items-center gap-6">
      <button
        className="grid size-9 place-items-center rounded-full text-secondary aria-pressed:text-primary"
        aria-label="Dislike"
        aria-pressed={status.data === 'DISLIKE'}
        disabled={status.isPending}
        onClick={() => setLiked.mutate({ videoId, liked: false })}
      >
        <ThumbsDown size={21} />
      </button>
      <button
        className="grid size-9 place-items-center rounded-full text-secondary aria-pressed:text-primary"
        aria-label={liked ? 'Remove from Favourites' : 'Add to Favourites'}
        aria-pressed={liked}
        disabled={status.isPending}
        onClick={() => setLiked.mutate({ videoId, liked: !liked })}
      >
        <ThumbsUp size={21} fill={liked ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
