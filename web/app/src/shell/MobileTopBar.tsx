import { PrefetchLink } from '@/components/PrefetchLink';
import { LogoMark } from '@/components/icons/LogoMark';
import { useYtAuth } from '@/extension/useYtAuth';
import { useUi } from '@/state/ui';

/**
 * The phone's top bar, as Apple Music's: the large title of the page you're on
 * appears in the page itself, so this bar stays quiet: the wordmark home, and
 * the account (which opens Settings) in the corner. Search is a tab of its own
 * (MobileBottomBar), as it is on the phone.
 */
export function MobileTopBar() {
  return (
    <header className="hidden max-md:fixed max-md:inset-x-0 max-md:top-0 max-md:z-[calc(var(--z-web-chrome)-2)] max-md:flex max-md:h-[calc(var(--mobile-top-bar-height)+env(safe-area-inset-top))] max-md:items-end max-md:justify-between max-md:bg-header-material max-md:px-4 max-md:pb-1.5 max-md:[backdrop-filter:saturate(180%)_blur(20px)] md:hidden">
      <PrefetchLink to="/home" className="inline-flex items-center gap-1.5 type-[700_17px/21px]" aria-label="BitChord, Home">
        <LogoMark size={21} />
        <span>BitChord</span>
      </PrefetchLink>
      <AccountLink />
    </header>
  );
}

/** The account, in the corner: the avatar when signed in, a person glyph when not. It opens Settings. */
function AccountLink() {
  const auth = useYtAuth();
  const avatar = auth.state === 'ready' && auth.auth.signedIn ? auth.auth.active?.avatarUrl : null;
  const name = auth.state === 'ready' && auth.auth.signedIn ? auth.auth.active?.name : null;
  return (
    <PrefetchLink
      to="/settings"
      className="grid size-9 place-items-center rounded-full text-key"
      aria-label={name ? `Settings, signed in as ${name}` : 'Settings'}
    >
      {avatar ? (
        <img className="size-7 rounded-full bg-quinary object-cover" src={avatar} alt="" referrerPolicy="no-referrer" />
      ) : (
        <svg width={22} height={22} viewBox="0 0 22 22" fill="currentColor" aria-hidden="true">
          <circle cx="11" cy="7.5" r="3.6" />
          <path d="M3.6 18.4c0-3.4 3.3-5.4 7.4-5.4s7.4 2 7.4 5.4z" />
        </svg>
      )}
    </PrefetchLink>
  );
}

/** Re-exported for the drawer's old callers; the phone's chrome no longer uses it. */
export function useOpenDrawer(): (open: boolean) => void {
  return useUi((s) => s.setDrawerOpen);
}
