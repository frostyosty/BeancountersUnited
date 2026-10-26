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

export function useInvoiceTemplates() {
  return useQuery({
    queryKey: invoiceKeys.templates,
    queryFn: () => getJson<InvoiceTemplateSummary[]>("/api/invoices/templates"),
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
const IMAGE_URL = /^url\(\s*(["']?)\/api\/invoices\/images\/[0-9a-f-]{36}\1\s*\)$/i;

/** A style attribute with only safe declarations: no outside URLs, no script. */
function cleanStyle(style: string): string {
  return style
    .split(";")
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
