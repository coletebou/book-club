import { type FastifyInstance } from 'fastify';
import { type AppContext } from '../context';
import { compressBytes, MIN_COMPRESS_BYTES, preferredEncoding } from '../lib/compress';
import { type Block, type PrivacyPolicy, type Rich, SOURCE_URL, buildPrivacyPolicy } from '../services/privacy-policy';
import { safeOrigin } from './static';

/**
 * The privacy policy page (D227): a whole HTML document written here, not a route of the web
 * app, so it reads with no JavaScript, no sign-in and no service worker (which only falls back to
 * the app's shell offline, sw.ts). Its stylesheet and theme script are the web build's own public
 * files (apps/web/public/privacy.css, theme-init.js): without WEB_DIST it is plain, but complete.
 */
const PRIVACY_CSP = [
  "default-src 'none'",
  // /theme-init.js: the reader's theme before first paint (D118), the one script the page has.
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Escaped for HTML text and for a double- or single-quoted attribute. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(rich: Rich): string {
  return rich
    .map((part) => {
      if (typeof part === 'string') return esc(part);
      if ('strong' in part) return `<strong>${esc(part.strong)}</strong>`;
      return `<a href="${esc(part.href)}">${esc(part.link)}</a>`;
    })
    .join('');
}

function block(b: Block): string {
  switch (b.kind) {
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'list':
      return `<ul>\n${b.items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ul>`;
    case 'table': {
      // data-label: on a narrow screen each row is drawn as a card, its cells labelled (privacy.css).
      const rows = b.rows
        .map(
          (r) =>
            `<tr><th scope="row" data-label="Recipient">${esc(r.name)}</th><td data-label="What they receive">${esc(r.receives)}</td><td data-label="Why">${esc(r.purpose)}</td></tr>`,
        )
        .join('\n');
      return `<div class="providers"><table>\n<thead><tr><th scope="col">Recipient</th><th scope="col">What they receive</th><th scope="col">Why</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>`;
    }
  }
}

/** `2026-11-10` as `November 10, 2026`. */
function longDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function renderPrivacyPolicy(policy: PrivacyPolicy, origin: string | null): string {
  const toc = policy.sections.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.heading)}</a></li>`).join('');
  const sections = policy.sections
    .map((s) => `<section id="${esc(s.id)}" aria-labelledby="${esc(s.id)}-title">\n<h2 id="${esc(s.id)}-title">${esc(s.heading)}</h2>\n${s.blocks.map(block).join('\n')}\n</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<script src="/theme-init.js"></script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="How Book Club handles your information: what it collects, who receives it, how long it is kept and the choices you have.">
<title>Privacy Policy · Book Club</title>
${origin ? `<link rel="canonical" href="${esc(origin)}/privacy">\n` : ''}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/privacy.css">
</head>
<body>
<header class="masthead"><a class="brand" href="/">Book Club</a></header>
<main class="policy">
<h1>Privacy Policy</h1>
<p class="updated">Last updated: <time datetime="${esc(policy.updated)}">${esc(longDate(policy.updated))}</time></p>
${policy.intro.map(block).join('\n')}
<nav class="toc" aria-label="On this page"><ol>${toc}</ol></nav>
${sections}
</main>
<footer class="foot"><a href="/">Back to Book Club</a> · <a href="${esc(SOURCE_URL)}">Source code</a></footer>
</body>
</html>
`;
}

export function privacyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/privacy', async (request, reply) => {
    // The same origin the share cards use: PUBLIC_ORIGIN, or the Host it came on only when that is exactly an origin.
    const origin = safeOrigin(ctx, request);
    const html = Buffer.from(renderPrivacyPolicy(buildPrivacyPolicy(ctx.config, origin), origin), 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    // What it says follows this server's settings, which a deploy can change: never kept stale.
    reply.header('Cache-Control', 'no-cache');
    reply.header('Content-Security-Policy', PRIVACY_CSP);
    reply.header('Vary', ctx.config.PUBLIC_ORIGIN ? 'Accept-Encoding' : 'Accept-Encoding, Host');
    const encoding = html.byteLength >= MIN_COMPRESS_BYTES ? preferredEncoding(request.headers['accept-encoding']) : null;
    if (!encoding) return reply.send(html);
    reply.header('Content-Encoding', encoding);
    return reply.send(await compressBytes(html, encoding));
  });
}
