import type { Request, Response } from 'express';
import type { HealthResponse } from '@codflow/shared';
import { checkDatabaseConnection } from '../../db/prisma';
import { checkRedisConnection } from '../../redis';

/**
 * Health probes.
 *
 * Two endpoints because they answer different questions and a platform reacts
 * to them differently:
 *
 *  - **Liveness** asks "is this process wedged?" It must not touch a
 *    dependency. If it checked Postgres, a database blip would make every
 *    replica report unhealthy and the platform would restart all of them —
 *    turning a recoverable outage into a full cold start with an empty
 *    connection pool.
 *  - **Readiness** asks "can this process serve traffic right now?" It checks
 *    dependencies, and a failure removes the replica from the load balancer
 *    without killing it, so it rejoins as soon as the dependency returns.
 *
 * Neither is authenticated, and neither returns anything a prober should not
 * see: no versions of dependencies, no hostnames, no error text.
 */

const startedAt = Date.now();
const VERSION = process.env.npm_package_version ?? '1.0.0';

function uptimeSeconds(): number {
  return Math.round((Date.now() - startedAt) / 1_000);
}

/** `GET /api/health` — liveness. Never touches a dependency. */
export function live(_req: Request, res: Response): void {
  const body: HealthResponse = {
    status: 'ok',
    uptimeSeconds: uptimeSeconds(),
    version: VERSION,
  };
  res.status(200).json(body);
}

/** `GET /api/health/ready` — readiness. 503 when a dependency is unreachable. */
export async function ready(_req: Request, res: Response): Promise<void> {
  const [database, redis] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  const healthy = database && redis;

  const body: HealthResponse = {
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: uptimeSeconds(),
    version: VERSION,
    checks: { database, redis },
  };

  res.status(healthy ? 200 : 503).json(body);
}
