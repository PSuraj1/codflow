import { pino, type Logger, type LoggerOptions } from 'pino';
import { config } from '../config/env';

/**
 * Application logger.
 *
 * Redaction is the important part: this app handles merchant OAuth tokens and
 * shopper PII, and logs are the easiest place to leak both. The paths below are
 * removed before serialization, so an accidental `logger.info({ req })` or
 * `logger.error({ session })` cannot spill a token into a log aggregator.
 *
 * Add a path here whenever a new secret-bearing field is introduced. Redaction
 * is cheap; a leaked access token is not.
 */
const redactPaths = [
  // Request/response headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-shopify-hmac-sha256"]',
  'req.headers["x-shopify-access-token"]',
  'res.headers["set-cookie"]',

  // Shopify session objects
  'accessToken',
  '*.accessToken',
  'session.accessToken',
  'refreshToken',
  '*.refreshToken',

  // Encrypted-at-rest columns, in case a whole row is logged
  '*.accessTokenEnc',
  '*.refreshTokenEnc',
  '*.msg91AuthKeyEnc',
  '*.twilioAuthTokenEnc',
  '*.whatsappTokenEnc',
  '*.firebaseServiceAccountEnc',
  '*.ipIntelApiKeyEnc',

  // Shopper PII — present on every COD order payload
  '*.phone',
  '*.phoneE164',
  '*.email',
  '*.address1',
  '*.address2',
  'payload.customer',
  'payload.shipping_address',
  'payload.billing_address',

  // Secrets that could arrive via config dumps
  '*.apiSecret',
  '*.sessionSecret',
  '*.encryptionKey',
  '*.password',
  '*.codeHash',
];

const options: LoggerOptions = {
  level: config.server.logLevel,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'codflow-api', env: config.env },
  formatters: {
    // Emit `level: "info"` rather than `level: 30`, which most log platforms
    // handle better than pino's numeric default.
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Pretty output in development only. pino-pretty is a devDependency, so it must
 * never be referenced in production — hence the transport is attached
 * conditionally rather than via a config flag.
 */
export const logger: Logger = config.isProduction
  ? pino(options)
  : pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
    });

/** Child logger tagged with a subsystem name, e.g. `createLogger('shopify')`. */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
