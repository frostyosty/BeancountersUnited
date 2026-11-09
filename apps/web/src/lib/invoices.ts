// The invoice maker's link to the server: each user's draft, templates and images, kept with their
// account (server: crates/server/src/invoices.rs). Pages are HTML the editor writes; they're cleaned
// with sanitizeInvoiceHtml before they're shown, whatever the server sent.
import type { InvoiceDraft } from "@acct/types/InvoiceDraft";
import type { InvoiceTemplate } from "@acct/types/InvoiceTemplate";
import type { InvoiceTemplateSummary } from "@acct/types/InvoiceTemplateSummary";
import { useQuery } from "@tanstack/react-query";
import { getJson, submitCommand } from "./api";
import { newId } from "./id";

export const invoiceKeys = {
  draft: ["invoices", "draft"] as const,
  templates: ["invoices", "templates"] as const,
};

/** The draft as the server had it when the page opened. The editor owns it from then on. */
export function useInvoiceDraft() {
  return useQuery({
    queryKey: invoiceKeys.draft,
    queryFn: () => getJson<InvoiceDraft>("/api/invoices/draft"),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** `enabled` is false for someone who isn't signed in: there's no account to ask. */
export function useInvoiceTemplates(enabled = true) {
  return useQuery({
    queryKey: invoiceKeys.templates,
    queryFn: () => getJson<InvoiceTemplateSummary[]>("/api/invoices/templates"),
    enabled,
  });
}

export function fetchInvoiceTemplate(id: string): Promise<InvoiceTemplate> {
  return getJson<InvoiceTemplate>(`/api/invoices/templates/${id}`);
}

/**
 * Saves the draft. `leaving`: the page is closing, so the request is sent with `keepalive`,
 * which lets it finish after the tab has gone (browsers allow up to 64 KB that way).
 */
export async function saveInvoiceDraft(html: string, leaving = false): Promise<void> {
  const fetchFn: typeof fetch = leaving ? (input, init) => fetch(input, { ...init, keepalive: true }) : fetch;
  await submitCommand({ kind: "save_invoice_draft", payload: { html } }, newId(), fetchFn);
}

/** Uploads an image from a data URL; returns the URL the page shows it from. */
export async function uploadInvoiceImage(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const accepted = await submitCommand({
    kind: "add_invoice_image",
    payload: { content_base64: dataUrl.slice(comma + 1) },
  });
  return `/api/invoices/images/${accepted.entity_id}`;
}

// --- Without an account: the draft stays on this device -------------------------------------------
// Anyone can use the invoice maker. Without an account the draft is kept in this browser only, and an
// image is kept in the page itself (a data URL) instead of being uploaded.

const LOCAL_DRAFT_KEY = "wla.invoice.draft";

/** The draft kept on this device, or null if there isn't one (or the browser won't say). */
export function readLocalInvoiceDraft(): string | null {
  try {
    return localStorage.getItem(LOCAL_DRAFT_KEY);
  } catch {
    return null;
  }
}

/** Keeps the draft on this device. Throws if the browser refuses (storage full or blocked), which the editor shows as "couldn't save". */
export async function saveLocalInvoiceDraft(html: string): Promise<void> {
  localStorage.setItem(LOCAL_DRAFT_KEY, html);
}

/** Forgets the draft kept on this device. */
export function clearLocalInvoiceDraft(): void {
  try {
    localStorage.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    // Nothing to forget, or the browser won't let us.
  }
}

const LOCAL_IMAGE = /data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}/g;

/**
 * A page's images kept in the page as data URLs (made without an account) uploaded to the account, and
 * swapped for the account's URLs, so the page can be saved there. Throws if an upload fails, leaving the
 * caller with the original page.
 */
export async function moveImagesToAccount(html: string, upload: (dataUrl: string) => Promise<string>): Promise<string> {
  const urls = new Map<string, string>();
  for (const dataUrl of new Set(html.match(LOCAL_IMAGE) ?? [])) {
    urls.set(dataUrl, await upload(dataUrl));
  }
  return html.replace(LOCAL_IMAGE, (found) => urls.get(found) ?? found);
}

/** With nowhere to upload to, the page shows the image from its own data URL. */
export async function localInvoiceImage(dataUrl: string): Promise<string> {
  return dataUrl;
}

// --- Cleaning a page before it's shown ------------------------------------------------------------

/** Elements the editor makes, or that editing text can leave behind. */
const KEEP = new Set([
  "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "button", "input",
]);
/** Elements dropped with everything in them. Anything else unknown is unwrapped: its text stays. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta",
  "base", "svg", "math", "img", "picture", "video", "audio", "source", "track", "canvas", "form",
  "textarea", "select", "option", "template", "noscript", "title", "head",
]);
const ATTRIBUTES = new Set([
  "class", "style", "id", "contenteditable", "tabindex", "hidden", "title", "colspan", "rowspan",
  "data-font",
]);
// An image is the user's own upload, or (with no account) a PNG, JPEG, GIF or WebP kept in the page as a data URL.
const IMAGE_URL =
  /^url\(\s*(["']?)(?:\/api\/invoices\/images\/[0-9a-f-]{36}|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2})\1\s*\)$/i;

/** Splits a style attribute at its semicolons, except those inside brackets or quotes (a data URL has one). */
function splitDeclarations(style: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < style.length; i++) {
    const c = style[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
    } else if (c === ";" && depth === 0) {
      parts.push(style.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(style.slice(start));
  return parts;
}

/** A style attribute with only safe declarations: no outside URLs, no script. */
function cleanStyle(style: string): string {
  return splitDeclarations(style)
    .map((d) => d.trim())
    .filter((d) => {
      if (!d) return false;
      const colon = d.indexOf(":");
      if (colon < 1) return false;
      const value = d.slice(colon + 1).trim();
      if (/javascript:|expression\s*\(|@import|\\/i.test(value)) return false;
      if (/url\s*\(/i.test(value)) {
        const property = d.slice(0, colon).trim().toLowerCase();
        return (property === "background-image" || property === "background") && IMAGE_URL.test(value);
      }
      return true;
    })
    .join("; ");
}

function cleanElement(el: Element) {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    cleanElement(child);
    if (!KEEP.has(tag)) {
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ATTRIBUTES.has(name) && !(tag === "input" && (name === "type" || name === "accept"))) {
        child.removeAttribute(attr.name);
      } else if (name === "style") {
        const style = cleanStyle(attr.value);
        if (style) child.setAttribute("style", style);
        else child.removeAttribute("style");
      }
    }
    if (tag === "input" && child.getAttribute("type") !== "file") child.remove();
    if (tag === "button") child.setAttribute("type", "button");
  }
  // Comments, and anything else that isn't an element or text, go too.
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) node.remove();
  }
}

/**
 * An invoice page, kept to what the editor itself makes: the elements, attributes and styles it uses,
 * and images only from the user's own uploads. Parsed in an inert template, so nothing in it runs.
 */
export function sanitizeInvoiceHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  // Cleaned inside the template's own inert document: moved into this page first, an <img> would load.
  const root = template.content.ownerDocument.createElement("div");
  root.append(template.content);
  cleanElement(root);
  return root.innerHTML;
}
