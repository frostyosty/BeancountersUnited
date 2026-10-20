// Build-time site settings from the repo's config.env, and the SEO files that depend on them.
// Node-side only: vite.config.ts imports this, the app does not.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const CONFIG = fileURLToPath(new URL("../../config.env", import.meta.url));

/** Public pages, for the sitemap. Keep in step with the signed-out routes in App.tsx. */
const PAGES = ["/", "/product", "/accountants", "/pricing", "/about"];

const TITLE = "White Label Accounting: online accounting for NZ small business";
const DESCRIPTION =
  "Upload your bank statements, see the tax you'd pay if you filed today, then cut it down. " +
  "Online accounting for NZ small businesses and their accountants, with GST and income tax returns filed with IRD.";

export interface SiteConfig {
  /** True while the public site is hidden behind the header-tap gate and kept out of search. */
  gate: boolean;
  url: string;
}

/** `KEY=value` lines; `#` comments, blanks and quotes around values are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Real environment variables win over config.env. No config.env means the gate stays on. */
export function readSiteConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const file = existsSync(CONFIG) ? parseEnv(readFileSync(CONFIG, "utf8")) : {};
  const get = (k: string) => env[k] ?? file[k];
  const gate = (get("SITE_GATE") ?? "on").toLowerCase();
  return {
    gate: !["off", "false", "0", "no"].includes(gate),
    url: (get("SITE_URL") || "https://acct-test.fly.dev").replace(/\/+$/, ""),
  };
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Gate on: `noindex` and a robots.txt that blocks everything.
 * Gate off: a description, social tags, JSON-LD, a plain-HTML summary inside `#root` (React
 * replaces it on load, but crawlers that don't run JavaScript read it), robots.txt and a sitemap.
 */
export function sitePlugin(site: SiteConfig): Plugin {
  return {
    name: "site-seo",
    transformIndexHtml(html) {
      if (site.gate) {
        return html.replace("</head>", `    <meta name="robots" content="noindex, nofollow" />\n  </head>`);
      }
      const head = [
        `<meta name="description" content="${escapeAttr(DESCRIPTION)}" />`,
        `<link rel="canonical" href="${site.url}/" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:title" content="${escapeAttr(TITLE)}" />`,
        `<meta property="og:description" content="${escapeAttr(DESCRIPTION)}" />`,
        `<meta property="og:url" content="${site.url}/" />`,
        `<meta name="twitter:card" content="summary" />`,
        `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "White Label Accounting",
          applicationCategory: "BusinessApplication",
          description: DESCRIPTION,
          url: site.url,
          areaServed: "NZ",
        })}</script>`,
      ].join("\n    ");
      const body = `<div id="root">
      <h1>Know your tax before the tax man does.</h1>
      <p>${DESCRIPTION}</p>
      <ul>
        <li>Upload your bank statements and have your transactions ready to sort.</li>
        <li>See a cautious estimate of the tax you'd pay if you filed today.</li>
        <li>Save tax: step through your spending and categorise it to bring that figure down.</li>
        <li>Real double-entry books for every business-year, so your accountant can pick up where you left off.</li>
        <li>File your GST and income tax returns with IRD.</li>
        <li>For accountants: client charts, journals, bank coding, an asset register with depreciation, and statements with prior-year comparatives.</li>
      </ul>
    </div>`;
      return html
        .replace(/<title>.*?<\/title>/, `<title>${TITLE}</title>`)
        .replace("</head>", `    ${head}\n  </head>`)
        .replace('<div id="root"></div>', body);
    },
    generateBundle() {
      const robots = site.gate
        ? "User-agent: *\nDisallow: /\n"
        : `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site.url}/sitemap.xml\n`;
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots });
      if (!site.gate) {
        const urls = PAGES.map((p) => `  <url><loc>${site.url}${p}</loc></url>`).join("\n");
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
        this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap });
      }
    },
  };
}
