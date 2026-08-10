/**
 * Why is the COD button not showing?
 *
 * Answers the single most common merchant report, from the one source that can
 * actually settle it: the theme's own `settings_data.json`, read through the
 * Admin API. Everything else — the app's config endpoint, the block in the
 * editor, the browser console — describes a symptom. This says whether the app
 * embed is switched on, on *which* theme, and whether it was disabled rather
 * than simply never added.
 *
 * The distinction that catches people: app embeds are per-theme and stored as
 * `"disabled": true/false` under `current.blocks`. A theme where the embed was
 * never added has no entry at all, which looks identical from the storefront
 * but means something different — one is "switch it on", the other is "you are
 * looking at the wrong theme".
 *
 *   npm run diagnose:theme -- <shop-domain>
 */

import { loadRootEnv } from '../lib/loadDotenv';

loadRootEnv();

import { adminGraphql } from '../shopify/graphql';
import { loadOfflineSession } from '../shopify/sessionStorage';
import {
  EmbedStatus,
  embedStatusFromSettings,
  parseThemeSettings,
} from '../shopify/themeEmbed';

/** Script wording for each state. Longer than the UI's, because this is read in a terminal. */
const VERDICT: Record<EmbedStatus, string> = {
  [EmbedStatus.ENABLED]: 'app embed ENABLED',
  [EmbedStatus.DISABLED]: 'app embed added but DISABLED',
  [EmbedStatus.ABSENT]: 'app embed NOT ADDED to this theme',
  [EmbedStatus.UNKNOWN]: 'could not determine',
};

const THEMES_QUERY = /* GraphQL */ `
  query CodFlowThemes {
    themes(first: 20) {
      nodes {
        id
        name
        role
      }
    }
  }
`;

const SETTINGS_QUERY = /* GraphQL */ `
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
  themes: { nodes: Array<{ id: string; name: string; role: string }> };
}

interface SettingsResponse {
  theme: { files: { nodes: Array<{ body: { content?: string } }> } } | null;
}

/**
 * The parser and the state rules live in `shopify/themeEmbed`, which the setup
 * guide also uses. Keeping one copy matters more than it looks: this script and
 * the merchant-facing checklist must agree on whether the embed is on, and two
 * implementations of a `settings_data.json` parser would eventually disagree
 * about some merchant's theme.
 *
 * What stays here is the part a diagnostic needs and the guide does not —
 * reporting on *every* theme rather than only the published one, which is how
 * you find an embed enabled on the wrong theme.
 */

async function main(): Promise<void> {
  const shopDomain = process.argv[2];

  if (!shopDomain) {
    process.stderr.write('\nUsage: npm run diagnose:theme -- <shop>.myshopify.com\n\n');
    process.exit(1);
  }

  const session = await loadOfflineSession(shopDomain);

  if (!session) {
    process.stderr.write(`\nNo offline session for ${shopDomain}. Is the app installed?\n\n`);
    process.exit(1);
  }

  const { themes } = await adminGraphql<ThemesResponse>(session, THEMES_QUERY);

  process.stdout.write(`\nThemes on ${shopDomain}\n\n`);

  for (const theme of themes.nodes) {
    const settings = await adminGraphql<SettingsResponse>(session, SETTINGS_QUERY, {
      variables: { id: theme.id },
    });

    const content = settings.theme?.files.nodes[0]?.body.content;
    let verdict = 'could not read settings_data.json';

    if (content) {
      try {
        const status = embedStatusFromSettings(parseThemeSettings(content));

        verdict = VERDICT[status];
      } catch {
        verdict = 'settings_data.json is not valid JSON';
      }
    }

    const marker = verdict === 'app embed ENABLED' ? 'ok  ' : '  ->';
    process.stdout.write(
      `  [${marker}] ${theme.role.padEnd(12)} ${theme.name.padEnd(34)} ${verdict}\n`,
    );
  }

  process.stdout.write(
    '\nThe theme that matters is the one you are viewing. `shopify app dev` previews a\n' +
      'DEVELOPMENT theme; enabling the embed on MAIN does nothing for it.\n\n',
  );

  process.exit(0);
}

void main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
