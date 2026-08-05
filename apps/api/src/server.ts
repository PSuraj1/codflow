import type { Server } from 'node:http';
import { config } from './config/env';
import { createLogger, logger } from './lib/logger';
import { checkDatabaseConnection, disconnectDatabase } from './db/prisma';
import { checkRedisConnection, disconnectRedis } from './redis';
import { close as closeMailer } from './lib/mailer';
import { API_VERSION } from './shopify/client';
import { toError } from './lib/errors';
import { createApp } from './app';

const log = createLogger('server');

/**
 * Process entry point.
 *
 * Two responsibilities beyond starting Express, both of which matter more in
 * production than they look:
 *
 *  - **Fail fast at boot.** Dependencies are checked before the port is bound,
 *    so a bad DATABASE_URL surfaces as a container that never becomes healthy
 *    rather than one that accepts traffic and 500s every request. Platforms
 *    treat those two very differently — the first blocks a rolling deploy, the
 *    second completes it.
 *  - **Drain on SIGTERM.** Railway and Render send SIGTERM and wait before
 *    SIGKILL. Closing the listener first stops new connections while in-flight
 *    requests finish, which is the difference between a seamless deploy and a
 *    handful of merchants seeing a failed COD order.
 */

/** How long in-flight requests get to finish before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 15_000;

let server: Server | null = null;
let shuttingDown = false;

async function verifyDependencies(): Promise<void> {
  const [database, redis] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  if (!database) {
    throw new Error('Cannot reach the database — check DATABASE_URL and that Postgres is running');
  }

  if (!redis) {
    throw new Error('Cannot reach Redis — check REDIS_URL and that Redis is running');
  }

  log.info('Dependency checks passed');
}

async function start(): Promise<void> {
  await verifyDependencies();

  const app = createApp();

  server = app.listen(config.server.port, () => {
    log.info(
      {
        port: config.server.port,
        env: config.env,
        appUrl: config.server.appUrl,
        apiVersion: API_VERSION,
      },
      'CodFlow API listening',
    );
  });

  // Node's default is 5s, below most load balancers' 60s idle timeout. When the
  // server closes a pooled connection first, the balancer can hand a request to
  // a socket that is already closing and the client sees a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
}

/**
 * Ordered shutdown: stop accepting work, then release what holds it.
 *
 * Redis is closed after the database because a queue connection dropped while a
 * transaction is still committing leaves BullMQ unable to record the outcome.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, 'Shutting down');

  const forceExit = setTimeout(() => {
    log.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);

  // Do not keep the event loop alive just for the timer.
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      log.info('HTTP server closed');
    }

    await closeMailer();
    await disconnectDatabase();
    await disconnectRedis();

    clearTimeout(forceExit);
    log.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ err: toError(error) }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection leaves the process in an unknown state — a
 * half-completed order push, a transaction that was never committed. Logging
 * and continuing risks corrupting data quietly, so the process exits and the
 * platform restarts it clean.
 */
process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ err: toError(reason) }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error: Error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException');
});

start().catch((error: unknown) => {
  logger.fatal({ err: toError(error) }, 'Failed to start CodFlow API');
  process.exit(1);
});
