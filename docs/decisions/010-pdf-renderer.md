# 010: The PDF renderer

Status: accepted (2026-10-25). The owner chose embedded Typst, the Source Sans 3 font, and not storing
PDF bytes at finalising (the ReportDoc plus its hash in each page footer is the record).
Follows ADR 003 (statements are a ReportDoc) and ADR 008 (one 512 MB Fly machine). Answers PLAN.md's
M15 item "PDF renderer: choose between embedded Typst and headless Chromium".

## Context
- ADR 003: the HTML preview and the PDF only render a ReportDoc. They do no arithmetic and make no
  layout decisions that change figures. Finalising stores the ReportDoc and its SHA-256; that stored
  document is the record of what was signed and is never regenerated.
- The server is one `acctd` binary on a `shared-cpu-1x` Fly machine with 512 MB, alongside Litestream
  (ADR 008). The image is `debian:bookworm-slim` plus two static binaries and `ca-certificates`.
- Statements are A4 with whole-dollar columns, negatives in brackets and nil as a dash
  (`docs/domain.md`, "Statement amounts and columns"). A statement can run past one page: a detailed
  P&L, the GL listing, the fixed asset schedule.
- The web app uses system fonts only and loads no font files (`apps/web/src/styles/global.css`).
- A PDF is printed, emailed to the client and signed. It has to look the same every time it's produced
  from the same ReportDoc.

The two candidates:
- **Embedded Typst.** The `typst` and `typst-pdf` crates (Apache-2.0) compiled into `acctd`. A fixed
  Typst template we write reads the ReportDoc JSON and lays it out. No other process.
- **Headless Chromium.** A Chromium (or `chrome-headless-shell`) installed in the image, driven over
  the DevTools protocol (for example `chromiumoxide`). We render an HTML page from the ReportDoc and
  call `Page.printToPDF`.

## Comparison

### Image size and memory on a 512 MB machine
- **Typst:** adds roughly 10–25 MB to `acctd` (the compiler, the PDF writer and our embedded fonts).
  Rendering a few statement pages takes tens of MB for well under a second, then frees it. Fits
  comfortably next to acctd and Litestream.
- **Chromium:** Debian's `chromium` package and its libraries add roughly 300–500 MB to the image;
  `chrome-headless-shell` is smaller but still a couple of hundred MB. A running browser typically sits
  at 100–300 MB, more per open page. On 512 MB that risks the kernel killing a process mid-render, and
  the process it picks could be acctd or Litestream. Realistically it means moving to 1 GB (about
  US$3 more a month) or launching Chromium per render, which is slow (one to two seconds of start-up).

### The build
- **Typst:** Rust only. `cargo build` as today; nothing changes in the Dockerfile. It builds on Windows
  for `acct-dev` and in CI with no extra packages. The cost is compile time: Typst is a large
  dependency tree, so a clean release build gets noticeably slower.
- **Chromium:** an `apt-get install` in the final stage, plus its fonts and sandbox settings (Chromium
  in a container usually needs `--no-sandbox` or extra privileges). acctd gains a child process to
  start, health-check, restart after a crash and time out. Tests that render need a browser, so CI and
  `make test` either install one or skip those tests. The Chromium version comes from Debian's security
  updates, not from our lockfile.

### Same ReportDoc, same PDF bytes
- **Typst:** deterministic for a given Typst version, template and font files. We control every input
  through Typst's `World` trait: fonts come from bytes embedded in the binary, there's no file system or
  package download, and `today()` returns none. We set `document(date: none)`, pass no timestamp to the
  PDF writer, and derive the PDF's document id from the ReportDoc's SHA-256. Fonts are embedded and
  subset. Pinning the exact `typst` version in `Cargo.toml` means bytes change only when we upgrade on
  purpose.
- **Chromium:** not deterministic out of the box. Its PDF writer puts `CreationDate` and `ModDate` in
  the metadata and has no option to leave them out, so we'd post-process every file to strip them. Layout
  and font subsetting also depend on the Chromium build, which changes with each Debian security update,
  so the same ReportDoc can give different bytes from one month to the next without any change of ours.
  Fonts are embedded if we install them in the image and the page references them.

### Page layout control
What statements need: whole-dollar columns aligned on the right digit, a statement's heading kept with
its first lines, a "(continued)" heading on later pages, and page numbers.
- **Typst:**
  - Columns: a `table`/`grid` with fixed column widths, right-aligned, tabular figures. Brackets can hang
    outside the digits (a fixed-width slot after the number) so `1,234` and `(1,234)` line up.
  - Keeping a heading with its lines: put the heading and its first few rows in an unbreakable `block`.
  - "Continued": a repeating table header (`table.header(repeat: true)`) plus a `context` check of
    whether this is the statement's first page, so later pages print "Statement of financial
    performance (continued)" and the column headings again.
  - Page numbers: the page footer has `counter(page)`, including "page 2 of 5" per statement or per
    document.
  - All of this is ordinary Typst and works the same everywhere.
- **Chromium:**
  - Columns: CSS tables align well, the same as the preview.
  - Keeping a heading with its lines: `break-after: avoid` and `break-inside: avoid` are honoured
    unevenly for table rows, so this usually takes workarounds such as wrapping the first rows in their
    own unbreakable block.
  - "Continued": `<thead>` repeats on each page, but the word "continued" can't be added only on later
    pages without measuring pages in script.
  - Page numbers: `printToPDF`'s header and footer templates (whole document only), or CSS `@page`
    margin boxes in recent Chromium.
  - Behaviour can change between Chromium releases.

### Fonts under an open licence
Either renderer can embed any font licensed under the SIL Open Font License (OFL), which allows
embedding in documents and bundling with software. Statements need tabular (equal-width) figures and a
legible regular and bold. Candidates, all OFL:
- **Source Sans 3** (Adobe): neutral, compact, tabular figures, wide language coverage.
- **IBM Plex Sans**: slightly more character, tabular figures.
- **Inter**: designed for screens; fine in print, but wider.
With Typst the font files are embedded in `acctd` with `include_bytes!`. With Chromium they're
installed in the image. Either way the licence text ships alongside (`assets/fonts/OFL.txt`) and no
system font is ever used, so a missing font can't silently change the layout.

### Keeping the HTML preview and the PDF consistent
Both only render a ReportDoc, so neither can change a figure. What can drift is presentation: how
amounts are formatted, which rows are bold, indents, headings.
- **Chromium's advantage** is that the PDF could reuse the preview's HTML and CSS, so there's one
  layout. In practice the print page still needs its own markup for paging, page numbers and
  "continued" headers, and it has to be rendered server-side from the ReportDoc rather than by the
  React app, so most of the sharing is the CSS.
- **With Typst** there are two renderers: the React preview and the Typst template. We keep them in step
  with:
  - one set of written rules, `docs/domain.md`'s statement presentation section, that both follow;
  - shared test vectors in `fixtures/presentation/amounts.json` (cents or dollars in, display text
    out: `-1234` → `(1,234)`, `0` → `–`, missing → blank) checked by vitest against the preview and by
    cargo test against the PDF's extracted text;
  - a test that, for each golden ReportDoc, the rows' labels and formatted amounts appear in the same
    order in the HTML and in the PDF's text.
- The preview stays on system fonts. Statements on screen aren't the signed record, and loading the
  PDF's font in the browser is optional polish we can add later.

## Decision: embedded Typst, with Source Sans 3
Source Sans 3 (OFL) is the only font in the PDFs, regular and bold, with tabular figures.
- It fits the 512 MB machine and the existing image with no new process to manage.
- It builds as plain Rust, so CI, `make test` and `acct-dev` on Windows all render PDFs with no browser.
- It gives byte-identical PDFs for the same ReportDoc, which Chromium can't promise even after
  post-processing.
- It does the paged-layout work statements need (headings kept with lines, "continued", page numbers)
  directly, where Chromium needs workarounds.
- The cost is a second renderer to keep in step with the preview, which the shared test vectors cover,
  and a slower clean build.

### How it would be built
- A new crate, `crates/pdf` (`acct-pdf`), with one entry point:
  `render(doc: &ReportDoc, ctx: &PrintContext) -> Vec<u8>`. `PrintContext` holds what isn't in the
  ReportDoc but is printed: the client's name and the practice's name. It does no IO: fonts and the
  template are embedded at compile time, so it's pure and deterministic. It stays out of `crates/core`
  only because Typst is a heavy dependency.
- The template, `crates/pdf/templates/statements.typ`, is our own (hard rule 3). It reads the ReportDoc
  JSON passed in as input rather than having Rust generate Typst source, so the template is a fixed,
  reviewable file and the renderer is literally "lay out this ReportDoc". It formats amounts itself,
  following `docs/domain.md`. No emoji (CLAUDE.md, Icons and emoji).
- The server exposes `GET /api/years/:id/report.pdf`. For a finalised year it renders the stored
  snapshot ReportDoc, never a rebuilt one. For an open year it renders the live ReportDoc, with a
  "Draft" mark on every page.
- The PDF isn't stored. The ReportDoc is the record (ADR 003). Each page's footer prints the
  first 12 hex characters of the ReportDoc's SHA-256, so any printout can be matched to its snapshot.
- `typst` and `typst-pdf` are pinned to an exact version. Upgrading is its own commit, which says
  whether PDF bytes changed and why.

### Testing
- **Golden tests stay on the ReportDoc JSON** (ADR 003). PDFs are never snapshotted, and no PDF bytes or
  hashes are committed.
- **What we check about the PDF**, in `crates/pdf` tests over the golden ReportDocs:
  - **Deterministic:** rendering the same ReportDoc twice, and from a ReportDoc round-tripped through
    JSON, gives identical bytes.
  - **No timestamps:** the PDF's info dictionary and XMP metadata have no `CreationDate` or `ModDate`,
    and the producer string is fixed.
  - **Fonts embedded:** every font in the file is embedded (has a font file stream), and it's one of
    ours.
  - **Content:** extracted text contains every row's label and formatted amounts, in order, per the
    shared amount vectors. This catches a dropped row or a mis-formatted figure without comparing
    layouts.
  - **Layout rules:** for a fixture long enough to break pages, each statement heading appears on the
    same page as its first row, later pages carry "(continued)", and every page has "Page n of m".
  - **Draft and final:** an open year's PDF carries the draft mark on every page; a finalised one
    doesn't, and its footer hash matches the snapshot's.
- Text extraction uses a small dev-dependency PDF reader (for example `lopdf`), only in tests.
- Visual checks (does it look right?) are by eye, from `acct-dev`, and noted in `NON-CODE-TODOS.md` for
  the first fixture of each statement.

## Consequences
- `acctd` gets bigger by tens of MB and its clean build gets slower. The Docker image and Fly machine
  stay as they are.
- There are two statement renderers, React and Typst, held together by `docs/domain.md` and the shared
  presentation tests. A presentation rule changes in both, in the same commit.
- The same ReportDoc gives the same PDF until we upgrade Typst, the template or a font, each of which is
  a deliberate commit.
- If we later need a renderer for something Typst can't lay out, this ADR is amended rather than adding
  Chromium alongside.

## Settled by the owner (2026-10-25)
1. Embedded Typst, not headless Chromium.
2. Source Sans 3, not IBM Plex Sans or Inter.
3. Finalising doesn't store PDF bytes. The ReportDoc and its hash, printed in each page footer, are
   enough.
