import { lazy, Suspense, useEffect } from 'react';
import { resumeSession } from '@/party/listenTogether';
import { startPartySync } from '@/party/partySync';
import { useDiscordPresence } from '@/playback/discordPresence';
import { startHistoryReporting } from '@/playback/historyReporting';
import { startLivePresence } from '@/playback/livePresence';
import { Outlet, useLocation } from 'react-router';
import { PrefetchLink } from '@/components/PrefetchLink';
import { config } from '@/config';
import { useBackend } from '@/extension/backend';
import { usePhoneLayout } from '@/lib/viewport';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { Banner, bannerButtonClass } from './Banner';
import { MobileBottomBar } from './MobileBottomBar';
import { MobileTopBar } from './MobileTopBar';
import { PlayerBar } from './PlayerBar';
import { SidePanel } from './SidePanel';
import { Sidebar } from './Sidebar';

// It carries am-lyrics; loaded the first time it opens, as the side panel's lyrics are.
const FullScreenPlayer = lazy(() => import('./FullScreenPlayer').then((m) => ({ default: m.FullScreenPlayer })));
// The phone's now-playing screen, likewise (its lyrics sheet is the same am-lyrics).
const MobileNowPlaying = lazy(() => import('./MobileNowPlaying').then((m) => ({ default: m.MobileNowPlaying })));

/**
 * The app frame (report §1): glass sidebar, the scrolling page, the floating
 * player pill, the side panel, and the bottom band when there is one.
 *
 * On a phone the same page runs under a different chrome: the sidebar folds
 * into the top bar and a drawer, the pill into the mini player and tab bar,
 * and the full-screen player into the now-playing sheet (MobileNowPlaying).
 */
export function AppShell() {
  useKeyboardShortcuts();
  useDiscordPresence();
  // Listen Together: pick a party back up after a reload, and keep the player in step with it.
  useEffect(() => {
    resumeSession();
    return startPartySync();
  }, []);
  // Plays into the account's YouTube Music history (Settings › Share Listening Activity).
  useEffect(() => startHistoryReporting(), []);
  // Counts this tab in the "listening now" figure beside the phone and PC apps.
  useEffect(() => startLivePresence(), []);
  const backend = useBackend();
  const bannerDismissed = useUi((s) => s.installBannerDismissed);
  const dismissBanner = useUi((s) => s.dismissInstallBanner);
  const fullScreen = useUi((s) => s.fullScreen);
  const nowPlayingOpen = useUi((s) => s.nowPlayingOpen);
  // A phone's mini player opens the now-playing screen; a desktop's pill opens
  // the full-screen player. Both are the same store, so one guards the other.
  const openNowPlaying = useUi((s) => s.setNowPlayingOpen);
  const hasTrack = usePlayer((s) => s.nowPlaying !== null);
  const mobile = usePhoneLayout();
  const { pathname } = useLocation();

  // Leaving the page closes the sheet, as Apple's does when a link takes over.
  useEffect(() => {
    openNowPlaying(false);
    // Only the path matters: a query change (a new search) keeps the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  let banner = null;
  // Only when YouTube is out of reach entirely: with the relay deployed, the
  // extension is an upgrade (local, the browser's own session, Spotify and
  // Discord), not a requirement, so the band's claim would be false. A phone
  // gets none at all: the extension can't be installed there.
  if (!mobile && backend.kind === 'none' && !bannerDismissed) {
    banner = (
      <Banner
        title="This deployment can’t reach YouTube Music."
        detail="No relay answered here, and the extension isn’t installed. Addons and lyrics still work."
        action={
          <PrefetchLink className={bannerButtonClass} to="/extension">
            Get the Extension
          </PrefetchLink>
        }
        onDismiss={dismissBanner}
      />
    );
  }

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)_auto]">
      {/* The side panel slides in from beyond the right edge; never let it scroll the page. */}
      <div className="relative min-h-0 overflow-hidden">
        <Sidebar />
        <MobileTopBar />
        {/* The page scrolls under the fixed chrome: the sidebar and pill on a
            desktop, the top bar and the tab bar (with the mini player) on a phone. */}
        <main
          id="scrollable-page"
          className="absolute inset-0 overflow-x-hidden overflow-y-auto pl-(--web-navigation-width) [scrollbar-gutter:stable] data-tint:bg-(--page-tint) data-tint:transition-[background-color] data-tint:duration-300 data-tint:ease-in max-md:pt-[calc(var(--mobile-top-bar-height)+env(safe-area-inset-top))] max-md:pl-0"
          data-with-player={hasTrack || undefined}
        >
          {/* Clears the floating pill (desktop) or the bottom chrome (phone). */}
          <div className="min-h-full pb-[calc(var(--player-pill-height)+var(--player-bottom-offset)+40px)] data-with-player:max-md:pb-(--mobile-bottom-chrome-with-player) max-md:pb-(--mobile-bottom-chrome)">
            <Outlet />
          </div>
        </main>
        <PlayerBar />
        <SidePanel />
        <MobileBottomBar />
      </div>
      {banner}
      {nowPlayingOpen ? (
        <Suspense fallback={null}>
          <MobileNowPlaying />
        </Suspense>
      ) : (
        fullScreen && (
          <Suspense fallback={null}>
            <FullScreenPlayer />
          </Suspense>
        )
      )}
    </div>
  );
}
