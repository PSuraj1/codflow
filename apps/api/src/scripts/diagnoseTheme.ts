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

/** An app embed entry in `settings_data.json`, keyed by an opaque block id. */
interface EmbedBlock {
  type?: string;
  disabled?: boolean;
}

/**
 * Parses `settings_data.json`, which is not JSON.
 *
 * Shopify's own themes ship it with a `/* … *\/` banner at the top, and the
 * theme editor preserves whatever comments a developer adds. `JSON.parse`
 * rejects the file outright, which reads as "the theme is broken" when it is
 * perfectly normal.
 *
 * Comment stripping is done outside string literals only — a naive replace
 * would corrupt any setting whose value contains `//`, which every theme has
 * the moment a merchant saves a URL.
 */
function parseSettings(source: string): unknown {
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
        const parsed = parseSettings(content) as {
          current?: { blocks?: Record<string, EmbedBlock> };
        };

        const blocks = Object.values(parsed.current?.blocks ?? {});

        // The block type is `shopify://apps/<handle>/blocks/<block>/<uuid>`, so
        // matching on the file name is what survives the handle changing.
        const embed = blocks.find((block) => (block.type ?? '').includes('app-embed'));

        verdict = !embed
          ? 'app embed NOT ADDED to this theme'
          : embed.disabled
            ? 'app embed added but DISABLED'
            : 'app embed ENABLED';
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
