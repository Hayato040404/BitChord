import type { DetectedExtension } from '@bitchord/shared/bridge';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { relayAvailable } from '@/portable/relay';
import { extensionQueryKey, useExtension } from './useExtension';

/**
 * Where YouTube requests come from. The extension is preferred (it is local,
 * uses the browser's own session, and costs the user nothing); without it the
 * site's own relay takes over (portable/relay.ts), which is how a phone that
 * can't install an extension browses and plays at all.
 */
export type Backend = 'extension' | 'relay' | null;

export const relayQueryKey = ['relay', 'available'] as const;

/**
 * Whether the relay answers. Its routes are the site's own `/api/yt` and
 * `/api/media` on Cloudflare Pages and in development; an OPTIONS probe is
 * cheap and says whether this deployment has them.
 */
export function useRelayAvailable(): boolean {
  const query = useQuery({
    queryKey: relayQueryKey,
    queryFn: relayAvailable,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    // A self-hosted relay restarted behind the same origin needs no re-probe;
    // a deployment that gains one gets it on the next visit.
    refetchOnWindowFocus: false,
  });
  return query.data === true;
}

/** The backend right now, for code outside React. */
export function backendSnapshot(): Backend {
  const extension = queryClient.getQueryData<DetectedExtension | null>(extensionQueryKey);
  if (extension?.info.capabilities.includes('yt')) return 'extension';
  if (queryClient.getQueryData<boolean>(relayQueryKey) === true) return 'relay';
  return null;
}

export type BackendStatus =
  | { kind: 'checking' }
  | { kind: 'extension'; extension: DetectedExtension }
  | { kind: 'relay' }
  | { kind: 'none' };

/**
 * The chosen backend, waiting for the extension check to settle before
 * settling on the relay: on a desktop with the extension installed, a relay
 * request must never be made first.
 */
export function useBackend(): BackendStatus {
  const extension = useExtension();
  const relay = useRelayAvailable();
  if (extension.state === 'checking') return { kind: 'checking' };
  if (extension.state === 'present' && extension.extension.info.capabilities.includes('yt')) {
    return { kind: 'extension', extension: extension.extension };
  }
  // The extension's first ping already missed; the relay (if deployed) stands in.
  return relay ? { kind: 'relay' } : { kind: 'none' };
}
