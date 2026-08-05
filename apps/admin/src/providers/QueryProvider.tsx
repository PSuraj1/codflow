import { type ReactNode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../lib/apiClient';

/**
 * React Query configuration.
 *
 * The retry policy is the part worth reading. React Query retries three times
 * by default, which is wrong for this API in two directions: a 401 or 403 is
 * already handled inside the fetch client (token refresh, re-auth redirect) and
 * retrying it just delays the redirect, while a 422 will fail identically
 * however many times it is sent. Only genuinely transient failures — network
 * errors, 5xx, 429 — are worth a second attempt.
 */

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;

  if (error instanceof ApiError) {
    // 4xx other than 429 is a client-side problem; the same request will keep
    // failing. 401/403 are already resolved by the client itself.
    if (error.status < 500 && error.status !== 429) return false;
  }

  return true;
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        // An embedded app is opened and closed constantly as merchants move
        // around the admin. Refetching everything on every focus makes the app
        // feel busy and burns a merchant's Shopify API rate limit.
        refetchOnWindowFocus: false,
        // COD orders arrive continuously, so cached lists go stale quickly, but
        // 30s is long enough that navigating between screens is instant.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
      },
      mutations: {
        // A mutation that failed may have partially applied. Retrying it
        // automatically risks creating a second order or a duplicate tag.
        retry: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // Created in state, not at module scope: a module-level client is shared
  // across every test and every hot reload, so cached data leaks between them.
  const [client] = useState(createClient);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
