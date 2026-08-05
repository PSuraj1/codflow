import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMatching } from '../matching';
import type { PixelEventPayload, ProviderConfig } from '../types';
import { metaProvider, tiktokProvider, providerFor } from './index';

/**
 * Provider translation.
 *
 * Every provider takes the same neutral event and produces a different wire
 * format. The failures worth catching are the quiet ones — a wrong event name
 * is accepted, recorded as a custom event nothing optimises against, and looks
 * like success in every dashboard the merchant checks.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ events_received: 1 }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    pixelId: '123456789012345',
    accessToken: 'test-token',
    testEventCode: null,
    conversionId: null,
    conversionLabel: null,
    advancedMatching: true,
    endpoint: null,
    ...overrides,
  };
}

function payload(overrides: Partial<PixelEventPayload> = {}): PixelEventPayload {
  return {
    eventName: 'PURCHASE',
    customEventName: null,
    eventId: 'cf-k3m9xq2a-purchase',
    eventTime: 1_785_000_000,
    sourceUrl: 'https://demo.myshopify.com/products/x',
    value: 1209,
    currency: 'INR',
    orderReference: 'CF-K3M9XQ2A',
    contents: [{ id: '111', quantity: 2, price: 400, title: 'T-shirt' }],
    matching: buildMatching({ email: 'asha@example.com', phone: '+919876543210' }),
    clientIpAddress: '203.0.113.7',
    clientUserAgent: 'Mozilla/5.0',
    fbp: 'fb.1.123.456',
    fbc: 'fb.1.123.abc',
    ttclid: 'ttclid-value',
    gclid: null,
    externalId: 'client-1',
    ...overrides,
  };
}

/** Reads the JSON body the provider posted. */
function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentUrl(): string {
  return String((fetchMock.mock.calls[0] as [string, RequestInit])[0]);
}

describe('registry', () => {
  it.each(['META', 'TIKTOK', 'GOOGLE_ADS', 'SNAPCHAT', 'PINTEREST', 'CUSTOM'] as const)(
    'resolves %s',
    (provider) => {
      expect(providerFor(provider)).not.toBeNull();
    },
  );
});

describe('Meta', () => {
  it('sends the standard event name, not the internal one', async () => {
    // `PURCHASE` would be recorded as a custom event no campaign optimises
    // against.
    await metaProvider.send(config(), payload());

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    expect(event.event_name).toBe('Purchase');
  });

  it('forwards the shared event id for deduplication', async () => {
    await metaProvider.send(config(), payload());

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    expect(event.event_id).toBe('cf-k3m9xq2a-purchase');
  });

  it('uses action_source website', async () => {
    await metaProvider.send(config(), payload());

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    expect(event.action_source).toBe('website');
  });

  /**
   * fbp, fbc, IP and user agent are Meta's own identifiers. Hashing them breaks
   * matching entirely, and Meta does not complain — it just stops matching.
   */
  it('sends Meta identifiers unhashed and personal details hashed', async () => {
    await metaProvider.send(config(), payload());

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    const userData = event.user_data as Record<string, string>;

    expect(userData.fbp).toBe('fb.1.123.456');
    expect(userData.client_ip_address).toBe('203.0.113.7');
    expect(userData.em).toMatch(/^[a-f0-9]{64}$/);
    expect(userData.ph).toMatch(/^[a-f0-9]{64}$/);
  });

  it('omits absent identifiers rather than sending null', async () => {
    await metaProvider.send(config(), payload({ fbc: null, gclid: null }));

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    expect(event.user_data).not.toHaveProperty('fbc');
  });

  it('includes the test event code only when set', async () => {
    await metaProvider.send(config({ testEventCode: 'TEST1234' }), payload());
    expect(sentBody().test_event_code).toBe('TEST1234');

    fetchMock.mockClear();
    await metaProvider.send(config(), payload());
    expect(sentBody()).not.toHaveProperty('test_event_code');
  });

  it('refuses without an access token, and does not retry', async () => {
    const result = await metaProvider.send(config({ accessToken: null }), payload());

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a 400 as terminal', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'Invalid pixel ID' } }),
    });

    const result = await metaProvider.send(config(), payload());

    expect(result.ok).toBe(false);
    // Retrying a malformed payload fails identically and burns quota.
    expect(result.retriable).toBe(false);
    expect(result.message).toBe('Invalid pixel ID');
  });

  it.each([429, 500, 503])('reports %i as retriable', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, text: async () => '{}' });

    const result = await metaProvider.send(config(), payload());
    expect(result.retriable).toBe(true);
  });

  it('treats a network failure as retriable', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const result = await metaProvider.send(config(), payload());

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it('keeps the access token out of the request body', async () => {
    await metaProvider.send(config(), payload());

    // Meta takes it on the query string; it must not also appear in the body,
    // which is what gets logged as `responseBody` context on failure.
    expect(JSON.stringify(sentBody())).not.toContain('test-token');
    expect(sentUrl()).toContain('access_token=');
  });
});

describe('TikTok', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, message: 'OK' }),
    });
  });

  it('maps PURCHASE to CompletePayment', async () => {
    // `Purchase` is accepted and silently recorded as a custom event.
    await tiktokProvider.send(config(), payload());

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    expect(event.event).toBe('CompletePayment');
  });

  it('sends the token as a header, not a query parameter', async () => {
    await tiktokProvider.send(config(), payload());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('test-token');
    expect((init.headers as Record<string, string>)['Access-Token']).toBe('test-token');
  });

  it('forwards ttclid unhashed', async () => {
    await tiktokProvider.send(config(), payload());

    const event = (sentBody().data as Array<Record<string, unknown>>)[0]!;
    expect((event.user as Record<string, string>).ttclid).toBe('ttclid-value');
  });

  /**
   * TikTok signals failure in the body while returning HTTP 200. Trusting the
   * status alone would report every rejected payload as delivered.
   */
  it('treats a non-zero code on HTTP 200 as a failure', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 40001, message: 'Invalid pixel code' }),
    });

    const result = await tiktokProvider.send(config(), payload());

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.message).toBe('Invalid pixel code');
  });

  it('treats a 5xxxx code as retriable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 50000, message: 'Internal error' }),
    });

    expect((await tiktokProvider.send(config(), payload())).retriable).toBe(true);
  });

  it('accepts a zero code as success', async () => {
    expect((await tiktokProvider.send(config(), payload())).ok).toBe(true);
  });
});

describe('event support', () => {
  it('reports which events a provider can carry', () => {
    expect(metaProvider.supports('PURCHASE')).toBe(true);
    expect(metaProvider.supports('CUSTOM')).toBe(false);
  });

  it('rejects an unsupported event without calling the network', async () => {
    const result = await metaProvider.send(config(), payload({ eventName: 'CUSTOM' }));

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
