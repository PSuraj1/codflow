import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { SessionResponse } from '@codflow/shared';
import { api } from '../lib/apiClient';

/**
 * The app's foundational query.
 *
 * `GET /api/admin/session` is the first request the admin makes, and it does
 * double duty: it proves the session-token exchange worked, and it returns
 * everything the shell needs — shop identity, plan, scope state, branding — in
 * one round trip rather than a waterfall in front of the first paint.
 *
 * Because on the server this call is also what triggers first-install
 * provisioning, it is deliberately *not* retried aggressively: a failure here
 * means the app cannot function at all, and the error screen is more useful to
 * a merchant than a spinner that never resolves.
 */

export const SESSION_QUERY_KEY = ['session'] as const;

export function useSession(): UseQueryResult<SessionResponse, Error> {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => api.get<SessionResponse>('/admin/session'),
    // The shop's plan and scopes change rarely, and every screen reads this.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
