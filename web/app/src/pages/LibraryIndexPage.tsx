import { ChevronRight } from 'lucide-react';
import { PrefetchLink } from '@/components/PrefetchLink';
import { DialGlyph, HeartGlyph, ClockGlyph, SparkGlyph } from '@/components/icons/LibraryGlyphs';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, LoadError } from '@/components/music/States';
import { Artwork } from '@/components/music/Artwork';
import { useLibrary, useLibraryPlaylists, useSignedIn, useYouTubeReady } from '@/data/music/queries';
import { useYtAuth } from '@/extension/useYtAuth';
import { PlainSkeleton } from '@/skeletons/PageSkeletons';

/**
 * The phone's Library tab (Apple Music's): the shortcuts as rows of glyphs,
 * then Recently Played as a strip of covers, then every playlist. The desktop
 * sidebar lists the same sections; this page is where a phone reaches them,
 * since the sidebar isn't there (MobileBottomBar).
 */
const shortcuts = [
  { to: '/library/recent', label: 'Recently Played', Glyph: ClockGlyph },
  { to: '/library/songs', label: 'Songs', Glyph: HeartGlyph },
  { to: '/library/albums', label: 'Albums', Glyph: DialGlyph },
  { to: '/library/artists', label: 'Artists', Glyph: SparkGlyph },
] as const;

const row = 'flex items-center gap-3.5 px-4 py-3 type-title-3 active:bg-quinary';
const icon = 'grid size-7 flex-none place-items-center text-key';

export default function LibraryIndexPage() {
  const { missing } = useYouTubeReady();
  const signedIn = useSignedIn();
  const auth = useYtAuth();
  const recent = useLibrary('recent');
  const playlists = useLibraryPlaylists();

  if (missing) {
    return (
      <>
        <PageHeader title="Library" />
        <EmptyState title="Library needs YouTube" detail="This build has no way to reach YouTube Music. The extension, or the site’s relay, provides one." />
      </>
    );
  }
  if (auth.state === 'ready' && !signedIn) {
    return (
      <>
        <PageHeader title="Library" />
        <EmptyState
          title="Sign in to see your library"
          detail="On a computer, BitChord uses the YouTube Music account the browser is signed in to. On a phone, import a session file from the extension."
          action={
            <PrefetchLink to="/settings" className="mt-3 inline-flex h-8 items-center rounded-pill bg-key-bg px-4 type-body-emphasized text-white">
              Open Settings
            </PrefetchLink>
          }
        />
      </>
    );
  }
  if (recent.isError && !recent.data) return <LoadError error={recent.error} onRetry={() => void recent.refetch()} />;
  if (!recent.data) return <PlainSkeleton />;

  const covers = recent.data.pages
    .flatMap((page) => page.data.tracks)
    .filter((track, index, all) => all.findIndex((t) => t.videoId === track.videoId) === index)
    .slice(0, 12);

  return (
    <>
      <PageHeader title="Library" />
      <ul className="mx-(--body-gutter) mt-2 overflow-hidden rounded-[10px] bg-quinary">
        {shortcuts.map(({ to, label, Glyph }) => (
          <li key={to} className="relative before:absolute before:top-0 before:right-0 before:left-[54px] before:border-t-[0.5px] before:border-t-divider first:before:hidden">
            <PrefetchLink to={to} className={row}>
              <span className={icon}>
                <Glyph size={24} />
              </span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <ChevronRight size={16} className="flex-none text-tertiary" />
            </PrefetchLink>
          </li>
        ))}
      </ul>

      {covers.length > 0 && (
        <section className="mt-6" aria-label="Recently Played">
          <h2 className="mx-(--body-gutter) type-title-2-emphasized">Recently Played</h2>
          <ul className="mt-3 flex snap-x snap-mandatory gap-4 overflow-x-auto px-(--body-gutter) pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {covers.map((track) => (
              <li key={track.videoId} className="w-[132px] flex-none snap-start">
                <Artwork src={track.thumbnail} displayWidth={132} radius="var(--radius-artwork-medium)" />
                <p className="mt-1.5 truncate type-callout">{track.title}</p>
                <p className="truncate type-callout text-secondary">{track.artists.map((a) => a.name).join(', ')}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-7" aria-label="Playlists">
        <h2 className="mx-(--body-gutter) type-title-2-emphasized">Playlists</h2>
        <ul className="mx-(--body-gutter) mt-2">
          <li>
            <PrefetchLink to="/library/playlists" className={`${row} rounded-[8px]`}>
              <span className="min-w-0 flex-1 truncate">All Playlists</span>
              <ChevronRight size={16} className="flex-none text-tertiary" />
            </PrefetchLink>
          </li>
          {playlists.data?.map((playlist) => (
            <li key={playlist.id}>
              <PrefetchLink to={`/playlist/${encodeURIComponent(playlist.id)}`} className={`${row} rounded-[8px]`}>
                <span className="w-10 flex-none">
                  <Artwork src={playlist.thumbnail} displayWidth={40} radius="var(--radius-artwork-small)" />
                </span>
                <span className="min-w-0 flex-1 truncate">{playlist.title}</span>
                <ChevronRight size={16} className="flex-none text-tertiary" />
              </PrefetchLink>
            </li>
          ))}
        </ul>
      </section>
      {/* The page's own bottom padding is the shell's job (AppShell). */}
      <div className="h-4" />
    </>
  );
}
