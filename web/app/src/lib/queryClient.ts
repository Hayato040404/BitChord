import { QueryClient } from '@tanstack/react-query';

/** The app's one query client; modules outside React read cached results from it. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// For browser-driven tests, next to __bcPlayer and __bcUi.
if (import.meta.env.DEV) Object.assign(window, { __bcQueryClient: queryClient });
