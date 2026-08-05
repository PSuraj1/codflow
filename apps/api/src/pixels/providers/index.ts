import type { PixelProvider } from '@codflow/shared';
import type { Provider } from '../types';
import { customProvider } from './custom';
import { googleAdsProvider } from './googleAds';
import { metaProvider } from './meta';
import { pinterestProvider } from './pinterest';
import { snapchatProvider } from './snapchat';
import { tiktokProvider } from './tiktok';

/**
 * Provider registry.
 *
 * Each one translates the neutral event the dispatcher builds into whatever its
 * platform expects. Adding a provider means adding a file and a line here —
 * nothing in the dispatcher, the queue or the admin needs to know about it.
 */

const REGISTRY: Readonly<Record<PixelProvider, Provider>> = {
  META: metaProvider,
  TIKTOK: tiktokProvider,
  GOOGLE_ADS: googleAdsProvider,
  SNAPCHAT: snapchatProvider,
  PINTEREST: pinterestProvider,
  CUSTOM: customProvider,
};

export function providerFor(provider: PixelProvider): Provider | null {
  return REGISTRY[provider] ?? null;
}

export { metaProvider, tiktokProvider, googleAdsProvider, snapchatProvider, pinterestProvider, customProvider };
