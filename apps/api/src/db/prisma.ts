import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';

const log = createLogger('prisma');

/**
 * PrismaClient singleton.
 *
 * Prisma holds its own connection pool, so exactly one instance must exist per
 * process. Under `tsx watch` the module graph is re-evaluated on every reload;
 * without the global cache below each reload would open a fresh pool and
 * Postgres would refuse connections within a few minutes of editing.
 */

declare global {
  // eslint-disable-next-line no-var
  var __codflowPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    // Emit as events rather than letting Prisma write to stdout, so queries go
    // through pino and inherit its redaction and formatting.
    log: config.isDevelopment
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
    errorFormat: config.isProduction ? 'minimal' : 'pretty',
  });

  if (config.isDevelopment) {
    client.$on('query', (event: Prisma.QueryEvent) => {
      // `event.params` contains bound values — shopper phone numbers and
      // addresses among them — so it is deliberately not logged.
      log.debug({ durationMs: event.duration, query: event.query }, 'query');
    });
  }

  client.$on('warn', (event: Prisma.LogEvent) => {
    log.warn({ target: event.target }, event.message);
  });

  client.$on('error', (event: Prisma.LogEvent) => {
    log.error({ target: event.target }, event.message);
  });

  return client;
}

export const prisma: PrismaClient = globalThis.__codflowPrisma ?? createPrismaClient();

if (!config.isProduction) {
  globalThis.__codflowPrisma = prisma;
}

/** Verifies the database is reachable. Used by the readiness probe and at boot. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    log.error({ err: error }, 'Database connection check failed');
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  log.info('Database disconnected');
}

/**
 * True when the error is Postgres' unique-constraint violation.
 *
 * Used to turn a race into an idempotent no-op — most importantly for
 * `WebhookEvent.shopifyWebhookId`, where two concurrent deliveries of the same
 * webhook should result in one processed event rather than an error.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** True when Prisma could not find a record it was told to update or delete. */
export function isRecordNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
