// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sampleInvoice } from "./invoiceEditor";
import { sanitizeInvoiceHtml } from "./invoices";

const IMAGE = "/api/invoices/images/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

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

  it("allows images only from the user's own uploads", () => {
    const own = sanitizeInvoiceHtml(`<div style='left: 1px; background-image: url("${IMAGE}")'></div>`);
    expect(own).toContain(IMAGE);
    expect(own).toContain("left: 1px");
    for (const url of ["https://tracker.example/pixel.png", "data:image/png;base64,AAAA", "/api/me"]) {
      const clean = sanitizeInvoiceHtml(`<div style='left: 1px; background-image: url("${url}")'></div>`);
      expect(clean).not.toContain(url);
      expect(clean).toContain("left: 1px");
    }
    expect(sanitizeInvoiceHtml('<div style="width: expression(steal())"></div>')).toBe("<div></div>");
  });
});
