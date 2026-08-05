/**
 * A deliberately small Markdown renderer.
 *
 * It exists to serve four documents that live in this repository — the privacy
 * policy, terms, data processing addendum and support page — whose URLs go on
 * the Shopify App Store listing. Nothing merchant-authored or shopper-authored
 * ever reaches it.
 *
 * That constraint is what justifies its size. It handles the constructs those
 * four files actually use and nothing else: headings, paragraphs, unordered
 * lists, task lists, tables, blockquotes, bold, inline code and links. A general
 * parser would be a dependency and a supply-chain surface for a page that
 * changes twice a year.
 *
 * `markdown.test.ts` renders the real documents and fails if any raw syntax
 * survives, so a construct added to a policy without support here is caught
 * rather than shipped as literal `##` on a public page.
 */

/** HTML-escapes text. Applied before any inline formatting is introduced. */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline formatting, applied to already-escaped text.
 *
 * Order matters: code spans first, so `**` inside backticks is not mistaken for
 * bold, and links before bold so a bold link renders as one.
 */
function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) =>
      // Only relative and https targets. These documents link to each other and
      // to nothing else, so anything odd is a mistake worth dropping the link
      // for rather than rendering.
      /^(https:\/\/|\/|[\w.-]+\.md)/.test(href)
        ? `<a href="${href.replace(/\.md$/, '')}">${label}</a>`
        : label,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** One `| a | b |` row into cells, dropping the leading and trailing pipes. */
function cells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

const isTableRow = (line: string) => line.startsWith('|') && line.endsWith('|');
const isTableDivider = (line: string) => /^\|[\s:|-]+\|$/.test(line);

export function renderMarkdown(source: string): string {
  const lines = source.split('\n');
  const html: string[] = [];

  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? '').trimEnd();

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // ---- Headings
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      index += 1;
      continue;
    }

    // ---- Tables. A header row, a divider, then body rows.
    if (isTableRow(line) && isTableDivider((lines[index + 1] ?? '').trim())) {
      const head = cells(line)
        .map((cell) => `<th>${inline(cell)}</th>`)
        .join('');

      const body: string[] = [];
      index += 2;

      while (index < lines.length && isTableRow((lines[index] ?? '').trim())) {
        const row = cells((lines[index] ?? '').trim())
          .map((cell) => `<td>${inline(cell)}</td>`)
          .join('');
        body.push(`<tr>${row}</tr>`);
        index += 1;
      }

      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }

    // ---- Blockquotes, including multi-line ones.
    if (line.startsWith('>')) {
      const quoted: string[] = [];

      while (index < lines.length && (lines[index] ?? '').trimEnd().startsWith('>')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }

      html.push(`<blockquote><p>${inline(quoted.join(' ').trim())}</p></blockquote>`);
      continue;
    }

    // ---- Unordered and task lists. A wrapped continuation line is indented.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];

      while (index < lines.length) {
        const current = (lines[index] ?? '').trimEnd();
        if (!/^[-*]\s+/.test(current)) break;

        let text = current.replace(/^[-*]\s+/, '');
        index += 1;

        while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? '')) {
          text += ` ${(lines[index] ?? '').trim()}`;
          index += 1;
        }

        const task = /^\[([ xX])\]\s*(.*)$/.exec(text);

        items.push(
          task
            ? `<li class="task">${task[1]?.trim() ? '☑' : '☐'} ${inline(task[2] ?? '')}</li>`
            : `<li>${inline(text)}</li>`,
        );
      }

      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ---- Ordered lists.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];

      while (index < lines.length) {
        const current = (lines[index] ?? '').trimEnd();
        if (!/^\d+\.\s+/.test(current)) break;

        let text = current.replace(/^\d+\.\s+/, '');
        index += 1;

        while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? '')) {
          text += ` ${(lines[index] ?? '').trim()}`;
          index += 1;
        }

        items.push(`<li>${inline(text)}</li>`);
      }

      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // ---- Paragraph. Runs until a blank line or a construct starts.
    const paragraph: string[] = [];

    while (index < lines.length) {
      const current = (lines[index] ?? '').trimEnd();

      if (
        current.trim() === '' ||
        /^(#{1,4}\s|[-*]\s|\d+\.\s|>)/.test(current) ||
        isTableRow(current)
      ) {
        break;
      }

      paragraph.push(current.trim());
      index += 1;
    }

    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return html.join('\n');
}

/**
 * Wraps rendered content in a standalone page.
 *
 * Self-contained on purpose: a policy URL is read by merchants, by Shopify's
 * reviewers and occasionally by a regulator, and it must render with no
 * JavaScript, no external stylesheet and no font that might fail to load.
 */
export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · CodFlow</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 6rem; color: #202223;
  }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 1.5rem; }
  h2 { font-size: 1.3rem; margin: 2.5rem 0 .75rem; }
  h3 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; }
  p, li { margin: .6rem 0; }
  ul, ol { padding-left: 1.3rem; }
  li.task { list-style: none; margin-left: -1.3rem; }
  a { color: #005bd3; }
  code { background: rgba(0,0,0,.06); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  blockquote {
    margin: 1.5rem 0; padding: .75rem 1rem; border-left: 3px solid #ffb703;
    background: rgba(255,183,3,.09);
  }
  blockquote p { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: .93rem; }
  th, td { border: 1px solid rgba(0,0,0,.15); padding: .5rem .65rem; text-align: left; vertical-align: top; }
  th { background: rgba(0,0,0,.04); }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e3e3e3; }
    a { color: #7cc4ff; }
    th { background: rgba(255,255,255,.06); }
    th, td { border-color: rgba(255,255,255,.18); }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
