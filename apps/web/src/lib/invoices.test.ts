// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sampleInvoice } from "./invoiceEditor";
import { moveImagesToAccount, sanitizeInvoiceHtml } from "./invoices";

const IMAGE = "/api/invoices/images/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("moveImagesToAccount", () => {
  it("uploads each image once and swaps in the account's URL", async () => {
    const a = "data:image/png;base64,AAAA";
    const b = "data:image/jpeg;base64,BBBB==";
    const uploaded: string[] = [];
    const html = `<div style="background-image: url(&quot;${a}&quot;)"></div><div style="background-image: url(&quot;${a}&quot;)"></div><div style="background-image: url(&quot;${b}&quot;)"></div>`;
    const moved = await moveImagesToAccount(html, async (url) => {
      uploaded.push(url);
      return `/api/invoices/images/${uploaded.length}`;
    });
    expect(uploaded).toEqual([a, b]);
    expect(moved).not.toContain("data:image");
    expect(moved.match(/images\/1/g)).toHaveLength(2);
    expect(moved).toContain("images/2");
  });

  it("leaves a page without images as it was", async () => {
    expect(await moveImagesToAccount("<div>Hi</div>", () => Promise.reject(new Error("no upload")))).toBe("<div>Hi</div>");
  });
});

describe("sanitizeInvoiceHtml", () => {
  it("keeps what the editor makes", () => {
    const sample = sampleInvoice(new Date(2026, 9, 26));
    expect(sanitizeInvoiceHtml(sample)).toBe(sanitizeInvoiceHtml(sanitizeInvoiceHtml(sample)));
    const clean = sanitizeInvoiceHtml(sample);
    expect(clean).toContain("TAX INVOICE");
    expect(clean).toContain('contenteditable="true"');
    expect(clean).toContain('<input type="file" accept="image/*" hidden="">');
    expect(clean).toContain("left: 45px");
  });

  it("drops script, handlers and outside links", () => {
    const clean = sanitizeInvoiceHtml(
      '<div onclick="steal()" class="invoice-element"><script>steal()</script><img src=x onerror="steal()">' +
        '<a href="javascript:steal()">Pay here</a><iframe src="https://example.com"></iframe>' +
        '<input type="text" value="x"><button onclick="steal()" type="submit">Go</button><!-- note --></div>',
    );
    expect(clean).not.toMatch(/steal|script|img|iframe|href|onclick|type="text"|note/);
    // A link's words stay; only the link goes.
    expect(clean).toContain("Pay here");
    expect(clean).toContain('<button type="button">Go</button>');
  });

  it("allows images only from the user's own uploads, or kept in the page (no account)", () => {
    const own = sanitizeInvoiceHtml(`<div style='left: 1px; background-image: url("${IMAGE}")'></div>`);
    expect(own).toContain(IMAGE);
    expect(own).toContain("left: 1px");
    // A data URL has a semicolon of its own: it mustn't split the declaration or be lost.
    const kept = "data:image/png;base64,iVBORw0KGgo=";
    const local = sanitizeInvoiceHtml(
      `<div style='left: 1px; background-image: url("${kept}"); background-size: contain'></div>`,
    );
    expect(local).toContain(kept);
    expect(local).toContain("left: 1px");
    expect(local).toContain("background-size: contain");
    for (const url of [
      "https://tracker.example/pixel.png",
      "data:image/svg+xml;base64,AAAA",
      "data:text/html;base64,AAAA",
      "data:image/png;base64,AAAA\\3b",
      "/api/me",
    ]) {
      const clean = sanitizeInvoiceHtml(`<div style='left: 1px; background-image: url("${url}")'></div>`);
      expect(clean).not.toContain(url);
      expect(clean).toContain("left: 1px");
    }
    expect(sanitizeInvoiceHtml('<div style="width: expression(steal())"></div>')).toBe("<div></div>");
  });
});
