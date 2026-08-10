import type { Session } from '@shopify/shopify-api';
import { createLogger } from '../lib/logger';
import { shopHandle } from '../lib/shopDomain';
import { tryAdminGraphql } from './graphql';

const log = createLogger('theme-embed');

/**
 * Is the app embed switched on?
 *
 * The single most expensive thing a merchant can get wrong. A theme app
 * extension ships with every install but does **nothing** until the merchant
 * enables its app embed, and Shopify offers no API to enable it for them. Until
 * they do, the app looks installed, the admin looks configured, and the
 * storefront renders nothing at all — which reads as "this app is broken"
 * rather than "one switch is off".
 *
 * Worse, the setting is **per theme**. A merchant who enables it and later
 * duplicates or switches theme silently loses it, with no notification and no
 * visible change inside the app. That is why the setup guide recomputes this
 * every time rather than storing it once.
 *
 * The detection reads `config/settings_data.json` from the published theme,
 * which is the same thing the theme editor writes. It is the only way to
 * observe the state from the outside.
 */

const PUBLISHED_THEME_QUERY = /* GraphQL */ `
  query CodFlowPublishedTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        name
      }
    }
  }
`;

const THEME_SETTINGS_QUERY = /* GraphQL */ `
  query CodFlowThemeSettings($id: ID!) {
    theme(id: $id) {
      files(filenames: ["config/settings_data.json"], first: 1) {
        nodes {
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
      }
    }
  }
`;

interface ThemesResponse {
  themes: { nodes: Array<{ id: string; name: string }> };
}

interface SettingsResponse {
  theme: { files: { nodes: Array<{ body: { content?: string } }> } } | null;
}

/** An app embed entry in `settings_data.json`, keyed by an opaque block id. */
interface EmbedBlock {
  type?: string;
  disabled?: boolean;
}

export const EmbedStatus = {
  /** Added to the theme and switched on. The only state that renders. */
  ENABLED: 'ENABLED',
  /** Present in settings_data.json but toggled off. */
  DISABLED: 'DISABLED',
  /** Never added to this theme. */
  ABSENT: 'ABSENT',
  /** The check itself failed — see the type doc on `SetupStepState.UNKNOWN`. */
  UNKNOWN: 'UNKNOWN',
} as const;

export type EmbedStatus = (typeof EmbedStatus)[keyof typeof EmbedStatus];

export interface EmbedReport {
  readonly status: EmbedStatus;
  /** Published theme name, for a message that names what the merchant is looking at. */
  readonly themeName: string | null;
  /** Deep link straight to the app-embed pane of the theme editor. */
  readonly editorUrl: string | null;
}

/**
 * Parses `settings_data.json`, which is not JSON.
 *
 * Shopify's own themes ship it with a block-comment banner, and the theme
 * editor preserves whatever comments a developer adds. `JSON.parse` rejects the
 * file outright, which reads as "the theme is broken" when it is perfectly
 * normal.
 *
 * Comments are stripped outside string literals only. A naive replace would
 * corrupt any setting whose value contains `//` — which every theme has the
 * moment a merchant saves a URL.
 */
export function parseThemeSettings(source: string): unknown {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    const next = source[index + 1];

    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end - 1;
      continue;
    }

    output += character;
  }

  return JSON.parse(output);
}

/**
 * Reads the embed state out of parsed theme settings.
 *
 * Matching is on `app-embed` appearing in the block type rather than on the
 * full `shopify://apps/<handle>/blocks/app-embed/<uuid>` string, because the
 * handle is part of that path and this app's handle has already changed once.
 */
export function embedStatusFromSettings(parsed: unknown): EmbedStatus {
  const blocks = Object.values(
    (parsed as { current?: { blocks?: Record<string, EmbedBlock> } })?.current?.blocks ?? {},
  );

  const embed = blocks.find((block) => (block.type ?? '').includes('app-embed'));

  if (!embed) return EmbedStatus.ABSENT;

  return embed.disabled ? EmbedStatus.DISABLED : EmbedStatus.ENABLED;
}

/** `gid://shopify/OnlineStoreTheme/123` -> `123`, which is what the editor URL wants. */
function themeIdSuffix(gid: string): string | null {
  const suffix = gid.split('/').pop();
  return suffix && /^\d+$/.test(suffix) ? suffix : null;
}

/**
 * Checks the published theme.
 *
 * Only the published theme, deliberately: it is the one shoppers see, and
 * reporting on the seven unpublished copies a merchant has accumulated would
 * turn one clear answer into a list they have to interpret.
 *
 * Never throws. Every failure path returns `UNKNOWN` — this feeds a setup card,
 * and a dashboard that errors because a theme could not be read is worse than
 * one that admits it does not know.
 */
export async function readEmbedStatus(session: Session): Promise<EmbedReport> {
  const unknown: EmbedReport = {
    status: EmbedStatus.UNKNOWN,
    themeName: null,
    editorUrl: null,
  };

  try {
    const themes = await tryAdminGraphql<ThemesResponse>(session, PUBLISHED_THEME_QUERY);
    const theme = themes?.themes.nodes[0];

    if (!theme) return unknown;

    const suffix = themeIdSuffix(theme.id);
    const editorUrl = suffix
      ? `https://admin.shopify.com/store/${shopHandle(session.shop)}/themes/${suffix}/editor?context=apps`
      : null;

    const settings = await tryAdminGraphql<SettingsResponse>(session, THEME_SETTINGS_QUERY, {
      variables: { id: theme.id },
    });

    const content = settings?.theme?.files.nodes[0]?.body.content;

    if (!content) {
      return { status: EmbedStatus.UNKNOWN, themeName: theme.name, editorUrl };
    }

    return {
      status: embedStatusFromSettings(parseThemeSettings(content)),
      themeName: theme.name,
      editorUrl,
    };
  } catch (error) {
    log.warn({ shop: session.shop, err: error }, 'Could not read the app embed status');
    return unknown;
  }
}
