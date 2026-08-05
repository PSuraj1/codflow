import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';
import { createLogger } from './logger';
import { toError } from './errors';

const log = createLogger('mailer');

/**
 * Outbound email.
 *
 * SMTP is optional — most of what this app sends is a convenience (a merchant
 * alert about a failed sync). The one exception is GDPR compliance: when
 * Shopify forwards a `customers/data_request`, the app has 30 days to give the
 * merchant that customer's data, and email is how it gets there.
 *
 * When SMTP is not configured the transport is null and every send is a logged
 * no-op. That is deliberate: refusing to boot without SMTP would make the whole
 * app undeployable for a merchant who never enables notifications, and throwing
 * at send time would fail webhook handlers that must return 200 regardless.
 * Callers check `isEnabled` when the distinction matters.
 */

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!config.mail.isConfigured) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    // `secure: true` means implicit TLS on 465. On 587 the connection starts
    // plaintext and upgrades via STARTTLS, which nodemailer does automatically
    // — setting secure:true there produces a hang rather than an error.
    secure: config.mail.secure,
    ...(config.mail.user
      ? { auth: { user: config.mail.user, pass: config.mail.password ?? '' } }
      : {}),
    // A stuck SMTP handshake must not hold a webhook handler past Shopify's
    // 5 second budget.
    connectionTimeout: 10_000,
    greetingTimeout: 5_000,
    socketTimeout: 15_000,
    pool: true,
    maxConnections: 3,
  });

  return transporter;
}

export const isEnabled = (): boolean => config.mail.isConfigured;

export interface Attachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface SendOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: Attachment[];
}

/**
 * Sends a message. Returns false rather than throwing when delivery fails.
 *
 * Every caller of this is doing something secondary to the operation in
 * progress — alerting a merchant, delivering a compliance export — and none of
 * them should turn an SMTP outage into a failed webhook or a failed order.
 */
export async function send(options: SendOptions): Promise<boolean> {
  const transport = getTransport();

  if (!transport) {
    log.warn(
      { to: options.to, subject: options.subject },
      'SMTP is not configured — email not sent',
    );
    return false;
  }

  try {
    const info = await transport.sendMail({
      from: { name: config.mail.fromName, address: config.mail.fromAddress ?? '' },
      to: options.to,
      subject: options.subject,
      text: options.text,
      ...(options.html ? { html: options.html } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
    });

    log.info({ to: options.to, messageId: info.messageId }, 'Email sent');
    return true;
  } catch (error) {
    log.error({ err: toError(error), to: options.to }, 'Email delivery failed');
    return false;
  }
}

/** Verifies SMTP credentials. Used by the readiness probe and settings screen. */
export async function verify(): Promise<boolean> {
  const transport = getTransport();
  if (!transport) return false;

  try {
    await transport.verify();
    return true;
  } catch (error) {
    log.error({ err: toError(error) }, 'SMTP verification failed');
    return false;
  }
}

export async function close(): Promise<void> {
  transporter?.close();
  transporter = null;
}
