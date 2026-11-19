import { Library, Radio } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { PrefetchNavLink } from '@/components/PrefetchLink';
import { ForwardIcon, PauseIcon, PlayIcon } from '@/components/icons/Transport';
import { HomeIcon, SearchIcon } from '@/components/icons/NavIcons';
import { Artwork } from '@/components/music/Artwork';
import { getDuration, getPlayhead, usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

/**
 * The phone's bottom chrome, as Apple Music's: the mini player stacked on the
 * tab bar, both over a glass material and inset for the home indicator. The
 * page clears whatever height it ends up (--mobile-bottom-chrome, tokens.css).
 *
 * Home is Apple's "Listen Now"; New takes Radio's place (YouTube Music's
 * Explore is the closest thing BitChord has); Library opens an index of the
 * sections the desktop sidebar lists in full.
 */
const TABS = [
  { to: '/home', label: 'Home', Icon: HomeIcon, end: true },
  { to: '/new', label: 'New', Icon: Radio, end: false },
  { to: '/search', label: 'Search', Icon: SearchIcon, end: true },
  { to: '/library', label: 'Library', Icon: Library, end: true },
] as const;

const item = 'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 pt-1 pb-1';
const glyph = 'grid size-7 place-items-center';
const label = 'type-caption-2';

export function MobileBottomBar() {
  const hasTrack = usePlayer((s) => s.nowPlaying !== null);
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[calc(var(--z-web-chrome)-3)] border-t-[0.5px] border-t-divider bg-header-material pb-[env(safe-area-inset-bottom)] [backdrop-filter:saturate(180%)_blur(30px)] md:hidden"
      data-with-player={hasTrack || undefined}
    >
      <MiniPlayer />
      <nav aria-label="Main">
        <ul className="flex h-(--mobile-tab-bar-height) items-stretch">
          {TABS.map(({ to, label: name, Icon, end }) => (
            <li key={to} className="flex flex-1">
              <PrefetchNavLink to={to} end={end} className={`${item} text-tertiary aria-[current=page]:text-key`}>
                <span className={glyph}>
                  <Icon size={24} />
                </span>
                <span className={label}>{name}</span>
              </PrefetchNavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/**
 * The mini player: artwork, names, play/pause and next, with a 2px progress
 * line along its top edge. Its names open the now-playing screen; the two
 * buttons don't.
 */
function MiniPlayer() {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const { togglePlay, next } = usePlayer.getState();
  const open = useUi((s) => s.setNowPlayingOpen);
  const bar = useRef<HTMLSpanElement>(null);

  // Drawn from the media clock every frame, as the pill's is: no React state,
  // so a playing bar doesn't re-render the app.
  useEffect(() => {
    if (!nowPlaying) return;
    let frame = 0;
    const draw = () => {
      const head = getPlayhead();
      const duration = getDuration();
      const fraction = head && Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, head.sec / duration)) : 0;
      bar.current?.style.setProperty('--progress', String(fraction));
      if (!(head?.paused ?? true)) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [nowPlaying, playing]);

  if (!nowPlaying) return null;

  return (
    <div className="relative mx-2 mt-1.5 mb-0.5 flex h-(--mobile-mini-height) items-center gap-1 rounded-[12px] bg-quinary px-2">
      <span className="pointer-events-none absolute inset-x-3 top-0 h-0.5 overflow-hidden rounded-full bg-quaternary" aria-hidden="true">
        <span ref={bar} className="block size-full origin-left scale-x-(--progress) bg-key [--progress:0]" />
      </span>
      <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] py-1 text-start" aria-label="Open Now Playing" onClick={() => open(true)}>
        <span className="w-9 flex-none">
          <Artwork src={nowPlaying.artworkUrl} displayWidth={36} radius="var(--radius-artwork-small)" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate type-body-emphasized">{nowPlaying.title}</span>
          <span className="truncate type-callout text-secondary">{nowPlaying.artist}</span>
        </span>
      </button>
      <button className="grid size-9 flex-none place-items-center rounded-full text-primary" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
        {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
      </button>
      <button className="grid size-9 flex-none place-items-center rounded-full text-primary" aria-label="Next" onClick={next}>
        <ForwardIcon size={20} />
      </button>
    </div>
  );
}
