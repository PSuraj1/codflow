import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp, type Options } from 'pino-http';
import { logger } from '../lib/logger';

/**
 * HTTP access logging.
 *
 * Deliberately thin: the app logger already handles redaction, so this only
 * decides *what* to log and at which level. The serializers below are the
 * important part — pino-http's defaults dump the entire request object,
 * including every header, which on this app means Shopify HMACs, session tokens
 * and shopper phone numbers landing in the log aggregator.
 */

const options: Options = {
  logger,

  // Reuse the correlation id already on the request so access logs join up with
  // everything the handler logs afterwards.
  genReqId: (req: IncomingMessage) => (req as IncomingMessage & { requestId?: string }).requestId ?? '',

  customLogLevel: (_req, res, err) => {
    if (err) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    // Health probes fire every few seconds on Railway/Render and would drown
    // out real traffic at info level.
    return res.statusCode === 204 ? 'debug' : 'info';
  },

  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} ${err.message}`,

  serializers: {
    req(req: IncomingMessage & { id?: string; url?: string; method?: string }) {
      return {
        id: req.id,
        method: req.method,
        // Query strings can carry a `shop` and, on Google OAuth returns, a code.
        // Log the path only.
        url: req.url?.split('?')[0],
      };
    },
    res(res: ServerResponse) {
      return { statusCode: res.statusCode };
    },
  },

  // Health checks are the highest-volume route in production and carry no
  // information; drop them entirely rather than logging at debug.
  autoLogging: {
    ignore: (req: IncomingMessage) => {
      const url = req.url ?? '';
      return url.startsWith('/api/health') || url === '/favicon.ico';
    },
  },
};

export const httpLogger = pinoHttp(options);
