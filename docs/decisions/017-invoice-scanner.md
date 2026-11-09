# 017: The invoice scanner (read, check, match)

Status: accepted (2026-11-10). Settles M23 (`M23-PROMPTS.md`). The owner's calls are marked **DECISION
FOR ME** and listed at the end; all eight were accepted as recommended on 2026-11-10. D1 to D5 came
first. The same day the owner asked for two additions: read as much as possible without a model (13,
local OCR), and treat a purchase paid in parts as one supply for the $200 rule, which the tax
specialist has confirmed (14). Those brought D6 to D8. ADR 016 is the latest ADR, so this is 017.
Migration 0016 is the latest, so M23 takes 0017 (M24 has 0018).

## Context
- **What the bill is for.** The milestone's point is the GST record, not the reading. Over $200 the GST
  on an expense waits in 615 until the owner confirms they hold the supplier's taxable supply
  information (`acct_core::coding::SUPPLY_INFO_THRESHOLD`, strictly over 20,000 cents, on the whole bank
  line; `save_tax::confirm_supply_info`, `save_tax.rs:1039`). Today that confirmation is a tick with
  nothing behind it. A checked invoice matched to the line is the thing the tick claims to exist.
- **IRD's rules** for what the information must show are three tiers by the GST-inclusive value of the
  supply: up to $200, over $200, and over $1,000. Since 1 April 2023 it needn't be called a "tax
  invoice". `docs/domain.md` gains a "Tax invoices" section with the rules, from IRD's page read today.
- **What exists today** (checked against the code, 2026-11-10):
  - Statement files are kept whole in `statement_files.bytes` (migration 0012), written inside
    `import_statement`. The log keeps the SHA-256, not the bytes.
  - Signed-in uploads go through `POST /api/commands` as base64 JSON, so axum's default 2 MB body limit
    is the only cap (about 1.5 MB of file). A guest is capped at 1 MB a file, 5 MB held, and 200 MB for
    all guests together (`guests.rs:65`).
  - The invoice maker's images (`invoices.rs`) are typed from their bytes and served with `nosniff`.
    That's the pattern for serving a file back.
  - Every model call goes through `ai_usage::Metered` (ADR 016). It holds an `Arc<dyn Suggester>` and
    knows two kinds, `suggestion` and `explain`. A test fails if `Suggester`, `.suggest(` or `.explain(`
    appears outside `ai_usage.rs` and `main.rs`.
  - Production is one 512 MB Fly machine with a 1 GB volume, in Sydney (ADR 008, ADR 010).
- **Why ADR 011's reasoning doesn't carry over.** ADR 011 dropped the consent screen because nothing
  sent identifies anyone. A picture of an invoice can't be generalised: it carries the supplier's
  name and bank account, often the owner's name and address, and whatever else was in the frame. So
  stage 3 needs its own basis, below.

## Decision

### 1. Tax invoices: what the checks require
The rules, the allowance and a worked example are in `docs/domain.md`, "Tax invoices", every rule
marked **check** for the tax specialist. In short:

| Total (GST-inclusive) | Must show |
|---|---|
| Up to $200.00 | Supplier's name, the date, a description, the total |
| $200.01 to $1,000.00 | Also the supplier's GST number, and either the GST-exclusive amount, the GST and the total, or the total and a statement that it includes GST |
| Over $1,000.00 | Also the buyer's name and one more detail that identifies them: an address, phone, email, trading name, NZBN or website |

The checks fall into two groups, because they mean different things to the owner:
- **Reading checks**: the numbers hold together. The lines add up, subtotal plus GST is the total, the
  GST is what the rate for the date gives (within the allowance), the GST number passes the checksum,
  the currency is NZD, and the total was found. A failure means the file was misread, or the invoice
  is wrong. The bill can't be confirmed.
- **Records checks**: the fields the tier requires are there. A failure means the invoice is genuine
  but short as a record. The bill can be kept and matched, and confirming it releases nothing; the
  owner is told what to ask the supplier for.

*Reason: "your invoice doesn't add up" and "your invoice doesn't name you" call for different actions,
and only the first means we can't trust what was read.*

**The GST allowance:** the GST shown may differ from `gst_in_inclusive(total, rate)` by at most one
cent per line plus one cent, and never more than 50 cents. *Reason: suppliers who work GST out line by
line drift up to half a cent a line, and one cent covers rounding the subtotal; the cap stops a long
invoice with a GST-free item hiding inside the allowance.*

**The claim never comes from the bill.** Confirming moves the GST core already computed on the bank
line (3/23 of it at 15%) from 615 to 810, exactly as `confirm_supply_info` does. The bill's own GST
field never reaches the ledger. *Reason: the return claims 3/23 of the GST-inclusive purchases (boxes
11 and 12), so the bill only has to show the purchase was standard-rated throughout, which is what the
rate check tests.* A bill showing less GST than the full rate (some items without GST) fails the rate
check, because claiming 3/23 of the line would over-claim. Mixed-rate bills are out of M23.

**An unregistered supplier.** A bill whose GST is shown as nil and that has no GST number passes with
the verdict "no GST charged". Confirming it claims nothing, and the owner is told the line shouldn't
claim GST. A GST field that's simply missing proves nothing, so it's never read as nil.

### 2. The stages, and when to stop
Each file goes down the stages and stops at the first reading that **passes**: one whose reading checks
all pass. A reading that's only short on records passes too: another reader won't find a buyer's name
that isn't on the page. Its verdict is one of:

```rust
pub enum BillVerdict { Holds, Short, NoGstCharged, Fails }
```

The cascade:
1. **Sniff** the bytes (6). A type we don't take is refused before anything is stored.
2. **UBL XML** (stage `ubl`): read the fields directly. The reading is recorded whatever its verdict.
   UBL fields are exact, so a failing check is the invoice's own fault, and Read this with AI is never
   offered.
3. **A PDF with a text layer** (stages `pdf_template`, then `pdf_rules`): if the text contains a GST
   number that passes the checksum and this business has a template for it (5), the template is tried
   first, then the generic rules. The first that passes is recorded. If neither passes, the one with
   fewer failed checks is recorded (rules on a tie), and Read this with AI is offered.
4. **A photo or a scan** (an image, or a PDF whose text layer has fewer than 20 letters or digits on
   its first page, which is how most scans come): **local OCR** on our server (stages `ocr_template`,
   then `ocr_rules`), after the upload has returned (13). Its words go through the same templates and
   rules as a text layer. Words OCR isn't sure of are flagged, never guessed.
5. **The owner's answers.** When a reading fails only because some fields were unclear, the owner is
   shown each unclear bit of the page and asked what it says (`fill_bill_fields`, 13). Nothing leaves
   the server.
6. **The AI reader** (stage `ai`), only when pressed (3), and offered only when the stages above
   couldn't produce a passing reading. Its reading is recorded whatever its verdict. One that fails is
   `invalid` in `ai_usage`. With OCR off or unavailable (`acct-dev` without Tesseract, say), step 4 is
   skipped and a photo is "not read yet", as before.

The milestone's stage numbers stay as they were: stage 1 is UBL, stage 2 is everything read on our
server (a text layer, and now OCR with the owner's answers), and stage 3 is the AI.

The **final** reading is recorded, passing or not, so the owner and the accountant see what was read
and why it fails after a reload. Only a passing reading is matched or can be confirmed. *Reason: the
milestone shows a failing result with the fields as read; keeping it is what lets the accountant view
show it too.* This differs from the first draft of Agent 9's prompt ("refuses a failing result"):
`record_bill_reading` records it and `confirm_bill` refuses it, with the failing checks named. Nothing
posts either way.

Read this with AI also stays on offer for a stage-2 reading that's short, since rules can miss a
buyer's name that a model would find.

### 3. Stage 3: what is sent, and on what basis

**What could be sent:**

| | Page image | A crop | Text from local OCR |
|---|---|---|---|
| What it exposes | Everything visible on the page: supplier and buyer details, bank account numbers, handwriting, anything else in the frame | Less, if we knew where the fields were. We don't until something has read the page | The words only. Account numbers, emails, phones and the owner's names could be pattern-redacted (ADR 009, rules 2 to 6); other names stay |
| Accuracy | Best: vision models read layout, stamps and photos | Unreliable: no fixed crop fits every layout, and a wrong crop loses the total | Worse on photos and receipts (OCR errors, tables lost), and the model still has to find the fields |
| Cost per read (2026-10-23 list prices, ADR 009) | About 1,600 image tokens (width × height ÷ 750, after the provider shrinks it to about 1.15 megapixels; check against the provider's vision docs), 600 other input tokens and 300 output: about US$0.0004 on Haiku 5.5, US$0.007 on Sonnet 5.5 | Slightly less than the image | About US$0.0003 on Haiku. The OCR itself is free but costs memory and CPU |
| What it adds to the server | Nothing new | A layout detector, which is OCR by another name | Tesseract (C++ libraries, about 30 MB in the image, 100–200 MB per page on a 512 MB machine, a Windows build for `acct-dev` through vcpkg), or the pure-Rust `ocrs` (embedded models of about 10 MB, slower, young and lightly maintained) |

What local OCR would really add is a text layer for scans, so stage 2's rules and templates could read
photos with no model at all. The owner asked for exactly that, so it's adopted as its own stage (13),
**before** stage 3, not as what stage 3 sends. Stage 3 is then the fallback for pages OCR can't read.

**DECISION FOR ME (D1): what is sent. Accepted 2026-11-10: A.**
- **A. The page image (recommended).** Images only; a PDF is never sent whole. *Reason: it's the only
  option that reads photos well, it adds no dependency, and the owner chooses each file.*
- B. Text from local OCR, redacted. Revisit after the bake-off if stage 3's share is large.

With A, the request (`acct_ai::bill::request`, private fields, the only way to build one) carries
exactly:
- **For an image:** the image, with its metadata removed first. JPEG `APP1` (Exif, XMP), `APP13` and
  `COM` segments, and PNG `tEXt`, `zTXt`, `iTXt`, `eXIf` and `tIME` chunks, are dropped by walking the
  file's segments; nothing is decoded. *Reason: a phone photo's Exif holds the GPS position it was
  taken at.* The stored copy is stripped the same way at upload, so the stored SHA-256 is of the
  stripped copy, as M18 does with masked card numbers.
- **For a text-less PDF:** the first three pages, each only if it's one full-page JPEG (`DCTDecode`,
  which is what scanners write), sent as that JPEG, stripped as above. Any other PDF is "can't be sent:
  take a photo of it or save it as an image". *Reason: sending the PDF itself would send its metadata,
  every page and any attachments, and not every provider takes PDFs.*
- The fixed instructions and the output schema (12).
- **Never:** the file name, the business or owner's name, the bank lines, dates, the business's id,
  any other file, or anything IRD sent us. The model isn't told which business it's reading for.

The web app downscales a photo before upload (long edge 2,048 px, JPEG), which also drops its Exif in
the browser. The server strips again and doesn't trust that it happened.

**The basis.** The owner presses **Read this with AI** on one file, beside one plain line saying what
goes where. That press, per file, is a clearer consent than ADR 009's screen was, so no screen
(recommended, as ADR 011 removed it). The provider still processes only on our behalf (Privacy Act 2020
s 11), so IPP 12 doesn't apply. Because an invoice identifies the taxpayer, IR1269 4(h) and 4(i) may
apply where ADR 011 thought they didn't. The press is the consent; the evidence is the
`record_bill_reading` log entry (stage `ai`, the actor, the time) and the `ai_usage` row.

**DECISION FOR ME (D2): the line on the button. Accepted 2026-11-10 as recommended:**

> **Read this with AI**
> Sends a picture of this page to [provider], overseas, to read it. It isn't used for training and is
> deleted within 30 days. Nothing changes until you check it.

- `[provider]` is `Metered::provider()`, so it changes with the configuration.
- With ZDR in place, the second sentence becomes "It isn't kept or used for training."
- A 🔒 before the line is `<Emoji>` chrome.

**Who can press it:**
- The business's owner, and practice users with owner-level work on it (`Need::Owner`), as for uploads.
- **Never a guest:** the route is refused, and the web shows "Save your work to read invoices with AI",
  as `LockedForGuest` does. *Reason: ADR 014 promises nothing of a trial leaves the server.*
- **Never while viewing as someone**, even with changes on, and never an overseer as themselves:
  "Overseers can't send someone's invoice to the AI." *Reason: unlike suggestions and Explain better
  (ADR 016, 8), this sends the owner's own document; that's their consent to give, as ADR 013 treats
  the AI switch.* Overseers test on staging as a test owner, or in `acct-dev` with the fake.
- **The AI switch.** `set_ai_suggestions` off also turns this off. *Reason: ADR 011 promises "off stops
  all requests".*

**IRD.** Yes, IRD should know. Sending a document that identifies the taxpayer is a material change to
what leaves the server (IR1269 5.2(b)), unlike ADR 011's generalised lines. Tell our relationship
manager before stage 3 reaches real owners, and ask them to confirm in writing (the existing to-do).

**DECISION FOR ME (D3): what has to be done before real owners can use stage 3.** Accepted 2026-11-10
as recommended: IRD's
written confirmation and the privacy policy's new paragraph are required; ZDR isn't, because the line
says 30 days. Stages 1 and 2 send nothing and aren't held up by any of it. The server enforces the gate
with `ACCT_AI_INVOICE_READS=on`, unset (off) in production until then. With it off, the button isn't
offered.

### 4. Retention
- **Where:** in the database, as statement files are: `bills.bytes`, written by `attach_bill` inside its
  transaction. *Reason: backups, `secure_delete` and guest expiry already work for it, with no new
  service.* See D4 for what this means for space.
- **How long:** as long as the business's other data. An owner may rely on our copy as their GST
  record, which IRD expects to be kept for 7 years (domain.md, "Tax invoices"). The customer terms say
  whether owners should also keep their own (`NON-CODE-TODOS.md`).
- **Deleted:** by `delete_bill` (the bytes go; the log keeps the SHA-256, size and that it happened); by
  guest expiry (ADR 014, 6); and with the business, once deleting a business exists (M18's open item
  covers bills too).
- **Never stored:** the text layer, any OCR text, prompts or replies. The fields as read are stored,
  because they're the record, and so is the box of each field OCR found unclear (a position, no text).
- **At the provider:** 30 days, not used for training (ADR 009); ZDR applied for (`NON-CODE-TODOS.md`)
  covers invoice reads too. We send no batch requests and cache no images.

**Limits, shared with statement files:**

| Limit | Signed in | Guest |
|---|---|---|
| One file | 4 MB (D4) | 1 MB, as statements |
| Bytes held per business | D4 | The guest's 5 MB, statement files and bills together |
| All guests together | | The 200 MB, statement files and bills together |
| Bills held | D5 | 20 |

The upload route has its own body limit (6 MB of base64 JSON) and checks the size before decoding, as
`guests.rs` does.

**DECISION FOR ME (D4): space. Accepted 2026-11-10: A.** The pricing page promises Free owners up to 100,000 invoice uploads,
and production has a 1 GB volume. At about 300 KB a file that's 30 GB for one business.
- **A. Database now, with a cap per business (recommended):** 4 MB a file, 100 MB held per business,
  and uploads refused across the server once the database passes 70% of the volume. Move bill bytes to
  encrypted object storage before the promise matters. *Reason: it ships M23 with no new service, and
  the caps keep one business from filling the volume.*
- B. Object storage now (Tigris, through Fly). Cheaper per GB and no volume ceiling, but a new
  integration, a second place to back up and expire, and a second offshore-storage question.

### 5. Supplier templates
- **What's learned:** for each field, where its value sat on the page (page number and a box, as
  fractions of the page) and the value's format (date order, thousands separator, decimal mark). Never
  the words around it or the value itself. *Reason: positions are enough to read the next one, and
  they say nothing about anyone.*
- **The key:** the supplier's GST number, digits only. That number is already in the bill's fields. A
  template is applied when a checksum-valid number in a new file's text layer equals a key.
- **When:** only on `confirm_bill`, from a PDF (its text layer, or OCR's words for a scan), by finding
  each confirmed value in those words. Whichever stage read it, AI included. Templates are tried on
  photos too, but a hand-held photo rarely frames a page the same way twice, so the rules usually read
  those. That's how the awkward-layout fixture's second invoice is
  read without a model. A later confirm from the same supplier replaces it. *Reason: only fields an owner
  has checked are worth learning from.*
- **Per business only.** *Reason: a template is derived from one owner's real file. Shared across
  businesses, it would reveal who buys from whom, carry one owner's mistake into everyone's books, and
  tempt us into a "default templates" list built from client files, which is exactly what hard rule 1
  keeps out of the repo and the practice merchant lists.*
- **Kept** until the business goes (or the trial expires). Deleting a bill doesn't remove its template:
  the template holds nothing from that bill but positions.

### 6. File safety
- **Types, by their bytes; the name and extension are ignored:**
  - PDF: `%PDF-` in the first 1,024 bytes.
  - PNG: its 8-byte signature.
  - JPEG: `FF D8 FF`.
  - UBL: after an optional BOM and whitespace, an XML root `Invoice` in
    `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`.

  A PNG named `bill.pdf` is read as a PNG. A file of any other type is refused, whatever its name. So
  Agent 2's renamed fixture should be a type we refuse (HTML or ZIP named `.pdf`). Refused message:
  "Add a PDF, a photo (JPEG or PNG) or an e-invoice."
- **HEIC is out.** *Reason: decoding it needs a C library with patent baggage, and we don't need it:
  phones' file inputs hand over JPEG, and the web app's canvas downscale makes JPEG anyway.* A HEIC file
  gets "Take the photo again with Add invoice, or save it as a JPEG."
- **Caps:**
  - **Size**: as in 4.
  - **PDF**: at most 10 pages, counted from the page tree before anything is extracted. A PDF that
    needs a password is refused; one that opens without one is read. JavaScript, actions, links and
    attachments are ignored.
  - **Images**: width and height read from the header, at most 10,000 px a side and 40 megapixels.
    *Reason: a small file can claim a huge image.*
  - **XML**: no `<!DOCTYPE` at all, so no entities, external or otherwise; at most 64 levels deep and
    100,000 elements.
  - **Time**: stages 1 and 2 run in `spawn_blocking` with a 5-second limit. Past it the file is "not
    read yet", and stage 3 is offered if the file can be sent. OCR has its own limits (13).
- **Nothing fetched or followed:** URIs, `ExternalReference`s, links and embedded attachments in a UBL
  file or a PDF are never fetched or opened.
- **Served back** from `GET /api/bills/{id}/file`:
  - with its sniffed type, `X-Content-Type-Options: nosniff`, and
    `Content-Disposition: inline; filename="invoice.<ext>"` (never the uploaded name);
  - with `Content-Security-Policy: sandbox`, so a PDF opened in the browser can't run script on our
    origin;
  - UBL as `text/plain; charset=utf-8`, so no stylesheet or script in it ever runs.
- **File text is data:** readers return only fields; core checks them. No file text, field value, prompt
  or reply goes in a tracing log, an error message or a metric. The fields are stored as the record,
  and `command_log` holds them as it holds any command's payload.

### 7. The commands
All five go through the pipeline and `command_log`. Sections 13 and 14 add four more on the same terms
(`fill_bill_fields`, `group_payments`, `ungroup_payments`, `answer_possible_split`), so M23 has nine.
`attach_bill` and `record_bill_reading` are
**server-only**: refused on `POST /api/commands` (code `server_only`) and submitted by the bill routes
(9) as the signed-in user. *Reason: a browser that could send `record_bill_reading` could type an
invoice and label it as read from the file.* A new `SERVER_ONLY` list in `commands.rs` holds both, with
a test that every kind on it is refused from the commands route.

| Command | Payload | Stores | Changes figures |
|---|---|---|---|
| `attach_bill` | `{ client_id, file_name, content_base64, bank_line_id? }` | The bill: the stripped bytes, their SHA-256, size, type, pages, whether it has a text layer, and the line it was added from (a hint for matching) | No |
| `record_bill_reading` | `{ bill_id, fields: BillFields }` (the stage is in the fields) | The reading, with the checks the **server** ran (any sent are ignored), replacing an earlier one | No |
| `confirm_bill` | `{ bill_id, bank_line_ids: [..] }` | The match, and the template (5). For each line over $200 with a verdict of `Holds`, `confirm_supply_info`'s logic in the same command | Only through `confirm_supply_info` |
| `unmatch_bill` | `{ bill_id }` | Clears the match, and stops automatic proposals for this bill (the owner picks next time) | No |
| `delete_bill` | `{ bill_id }` | Deletes the bill, its bytes, reading and match | No |

- **`attach_bill`.** `logged_payload` replaces `content_base64` with `{ sha256, bytes }`, as
  `import_statement` does. The same bytes already held by this business are refused ("You've already
  added this invoice"), naming the existing bill. Refused on an example business: "This is an example.
  Add invoices to a business of your own." *Reason: an example never mixes with real files (ADR 014,
  1).*
- **`record_bill_reading`.** Refused on a confirmed bill ("Unmatch it first"). A failing reading never
  replaces a passing one: the AI route then returns `ai_unreadable` with "The AI's reading doesn't add
  up, so we kept the one we had." Strings are trimmed,
  stripped of control characters, and capped: names 120 characters, descriptions 200, invoice numbers
  40, at most 200 lines. A reading outside those caps is refused as malformed.
- **`confirm_bill`** is refused, with every failed check named, when the reading's verdict is `Fails`.
  The lines must be this business's money-out lines, not held by another confirmed bill, adding up
  exactly to the total, each within the date window (8). The owner may pick lines that matching didn't
  propose, as long as they pass those tests. A bill paid in parts may also take lines adding up to
  **less** than its total ("part paid"), and more lines later by confirming again (14).
  - **A bill on more than one line, or part paid, makes a purchase** (14) with the bill's total, so
    the $200 rule reads the bill's total, not each payment's.
  - **The verdict decides what's released:**
    - `Holds`: `save_tax::confirm_supply_info` for each line whose purchase is over $200. That
      includes payments of $200 or less towards a bill over $200. If a line isn't coded yet, the
      confirmation is recorded and the GST is claimed when it's coded, as today.
    - `Short`: nothing. The result names what to ask the supplier for. Payments of $200 or less towards
      a bill over $200 had their GST claimed already; the purchase now holds it in 615, and the result
      says the tax to pay rose (14).
    - `NoGstCharged`: nothing.
    - A bill of $200 or less releases nothing: its lines' GST was claimed already.
  - **Refused where `confirm_supply_info` would be** (a finalised year). Linking a bill to a line in a
    finalised year that releases nothing is allowed.
  - **Its reply.** `Accepted` gains `bill: Option<BillConfirmed>` (as M18 added `upload`), with what was
    released and the tax to pay before and after, taken from the same figures M13 records in `changes`.
    That's where the web gets "GST claimed: your tax to pay fell $45.00".
- **Unmatching or deleting a confirmed bill leaves `confirm_supply_info`'s confirmation as it is.**
  *Reason: that confirmation is the owner's statement that they hold the information, and never needed
  a file; deleting our copy doesn't mean they've lost theirs; and quietly withdrawing a claim, perhaps
  in a filed period, would be worse than leaving it.* The ConfirmDialog says so: "The GST you claimed
  stays claimed. If you no longer have this invoice anywhere, tell your accountant."
- **`remove_statement`** deletes the matches on the lines it removes, along with the rest of what hangs
  off them. The bill goes back to waiting.

**In Changes (M13):**
- `attach_bill`: "added an invoice (totara-2041.pdf)".
- `record_bill_reading`: "read an invoice from Tōtara Lane Timber: $345.00 on 3 Feb", with "with AI
  (Claude Haiku 5.5)" for stage `ai`, and ", which doesn't add up" when it fails.
- `confirm_bill`: "confirmed the invoice from Tōtara Lane Timber for the payment on 5 Feb", then
  M13's usual tax line ("GST claimed: tax to pay fell $45.00"), or "…; it doesn't name the buyer, so
  no GST was claimed yet".
- `unmatch_bill`: "unmatched the invoice from Tōtara Lane Timber from the payment on 5 Feb".
- `delete_bill`: "deleted an invoice (totara-2041.pdf)".

**While viewing as someone (M19):** all five go on `ALLOWED`, so they need "Allow changes". The upload
route is `NeedsChanges`. The AI route is `Refused` (3).

**Guests:** all five go on `GUEST_ALLOWED` (their own business, never an example). The upload and read
routes go on `route_allowed`; the AI route doesn't.

### 8. Matching
Matching is pure and deterministic: `acct_core::bill::matching`. **Proposals are worked out when a bill
is read, never stored;** only a confirmed match is stored. *Reason: a stored proposal goes stale every
time a statement is uploaded or removed, a line is recoded, or another bill is confirmed. Computing it
from current data is always right and needs no re-run hooks.* So a statement import needs no call into
matching: a waiting bill shows its match on the next read. This replaces the first draft's "the one
call into matching from the statement import".

- **Lines considered:** the business's money-out lines on every bank and card account, except those
  held by a confirmed bill, marked duplicates, and either half of a confirmed transfer. Lines coded as
  personal are considered: the bill may be what shows they weren't.
- **The date window:** from 7 days before the invoice date to 60 days after. *Reason: 60 days covers
  "20th of the month following" terms with room to spare; 7 days before covers deposits and card
  purchases the bank posts before the receipt's date.* A bill with no date doesn't match.
- **The amount:** a line of exactly minus the total, to the cent. A **split payment** is 2 or 3 lines,
  each with name evidence, adding up exactly to the total, considered only when no single line has the
  amount. At most the 20 evidenced lines nearest the invoice date are tried. *Reason: without evidence on
  every line, sums of unrelated lines would match by accident.* A part-paid bill is never proposed: the
  owner picks its lines (14).
- **A purchase the owner already made** (14) whose total equals a bill's total, with name evidence on
  one of its lines, is proposed as that bill's set ahead of other split sets, even if it's part paid:
  the owner has already said those payments are one purchase.
- **Name evidence**, on both sides upper-cased, macrons folded (`Ō` to `O`, since banks drop them),
  punctuation removed, spaces collapsed (core's `coding::normalise`, made public, plus the folding):
  - drop these words from the supplier's name: `LTD`, `LIMITED`, `NZ`, `NEW`, `ZEALAND`, `THE`, `AND`,
    `CO`, `COMPANY`, `GROUP`, `HOLDINGS`, `TRADING`, `TA`;
  - evidence is a remaining word of 3 or more letters that appears whole in the description, or a
    description word of 5 or more letters that starts one of them (banks cut names short);
  - or the invoice number's digits (4 or more, leading zeros dropped) appearing in the description.
- **The result:**

  ```rust
  pub enum BillMatch {
      None,
      One { lines: Vec<String> },             // bank line ids, oldest first
      Candidates { sets: Vec<Vec<String>> },  // each a line or a split set
  }
  ```

  - `One`: exactly one single line with the amount, in the window, with name evidence. Or no such
    line, and exactly one split set.
  - `Candidates`: lines with the amount and in the window, when there's more than one, or one with no
    name evidence. *Reason: nothing is guessed. The owner picks even a single candidate when nothing
    names the supplier.*
  - `None`: nothing in the window has the amount. The bill stays as evidence.
  - **The line it was added from wins.** A bill added from a line (`bank_line_id`) whose amount and date
    pass is `One` on that line, name or not, because the owner chose it. If it doesn't pass, matching
    runs as usual, and the view says "This invoice's total doesn't match that payment."
  - **Two bills, one line.** Two waiting bills whose `One` would be the same line both become
    `Candidates`.
  - **After `unmatch_bill`**, a bill gets `Candidates` at most, never `One`.
  - Sets are sorted by their lines' dates, then ids. Nothing returned depends on a map's order.

### 9. The API
New routes, and the access rule for each:

| Route | Rule | Notes |
|---|---|---|
| `POST /api/businesses/{id}/bills` | `Client(Need::Owner)` | Upload: `attach_bill`, then stages 1 and 2, then `record_bill_reading` |
| `POST /api/bills/{id}/ai-read` | `Bill(Need::Owner)` | Read this with AI |
| `GET /api/businesses/{id}/bills` | `Client(Need::Read)` | The owner's list, and the books' bank screen |
| `GET /api/bills/{id}` | `Bill(Need::Read)` | One bill |
| `GET /api/bills/{id}/file` | `Bill(Need::Read)` | The bytes (6) |

`RouteRule::Bill(Need)` is new: its `{id}` is a bill, checked as its business. The accountant view
(ADR 015) uses the same reads; it shows no buttons because the web's read-only context says so, and
the server's refusals are the control. Viewers get the reads only.

**The upload is idempotent** on its `command_id`, which becomes `attach_bill`'s id. Resubmitting returns
the bill as it is now. `record_bill_reading`'s id is the server's own.

The types, in `crates/server/src/bills.rs` with `#[derive(Serialize, TS)] #[ts(export)]`; times are RFC
3339 UTC strings, dates `YYYY-MM-DD`, money integer cents:

```rust
// Core (acct_core::bill), also with ts-rs:
pub struct BillFields {
    pub supplier_name: Option<String>,
    pub supplier_gst_number: Option<String>,     // digits only, 8 or 9
    pub invoice_number: Option<String>,
    pub date: Option<NaiveDate>,
    pub buyer_name: Option<String>,
    pub buyer_detail: Option<BuyerDetail>,       // which identifier is shown, not its value
    pub currency: Option<String>,                // ISO 4217 as shown; None is taken as NZD
    pub lines: Vec<BillLine>,
    pub lines_include_gst: bool,                 // receipts: true; most invoices: false
    pub subtotal: Option<Money>,                 // GST-exclusive
    pub gst: Option<Money>,
    pub total: Option<Money>,                    // GST-inclusive
    pub says_gst_included: bool,                 // "includes GST" or similar is shown
    pub stage: Stage,
    pub unclear: Vec<Unclear>,                   // OCR only (13): left empty, box kept
    pub typed: Vec<BillField>,                   // fields the owner answered (13)
}
pub struct BillLine { pub description: String, pub amount: Money }  // as shown; may be negative
pub enum BuyerDetail { Address, Phone, Email, TradingName, Nzbn, Website }
pub enum Stage { Ubl, PdfTemplate, PdfRules, OcrTemplate, OcrRules, Ai }
pub enum BillField {
    SupplierName, SupplierGstNumber, InvoiceNumber, Date, BuyerName,
    Subtotal, Gst, Total, LineAmount { index: u16 },
}
pub struct Unclear { pub field: BillField, pub page: u16, pub bbox: PageBox }
pub struct PageBox { pub x_bp: u32, pub y_bp: u32, pub w_bp: u32, pub h_bp: u32 }  // fractions of
                                                 // the page in basis points, top left origin
pub enum BillVerdict { Holds, Short, NoGstCharged, Fails }
pub enum CheckGroup { Reading, Records }
pub enum CheckName {
    TotalFound, LinesAddUp, SubtotalPlusGst, GstRateKnown, GstNotAboveRate, GstNotBelowRate,
    GstNumberChecksum, CurrencyNzd,
    SupplierName, Date, Description, SupplierGstNumber, GstBreakdown, BuyerIdentified,
}
pub enum CheckOutcome { Pass, Fail, NotApplicable }
pub struct BillCheck { pub name: CheckName, pub group: CheckGroup, pub outcome: CheckOutcome }
pub struct BillAssessment {                     // what core's checks return
    pub tier: BillTier,                          // up_to_200 | over_200 | over_1000
    pub checks: Vec<BillCheck>,                  // every check, in CheckName order
    pub verdict: BillVerdict,
}
pub enum BillTier { UpTo200, Over200, Over1000 }

// Server (crates/server/src/bills.rs):
pub struct BillUpload {
    pub command_id: String,
    pub file_name: String,
    pub content_base64: String,
    pub bank_line_id: Option<String>,
}
pub enum BillMediaType { Pdf, Png, Jpeg, Ubl }
pub enum BillStatus { NotRead, Reading, Read, Confirmed }   // Reading: queued for OCR (13)
pub struct BillView {
    pub id: String,
    pub client_id: String,
    pub file_name: String,
    pub media_type: BillMediaType,
    pub size_bytes: u32,
    pub pages: u32,
    pub added_at: String,
    pub added_by: Option<String>,                // display name, read live
    pub status: BillStatus,
    pub reading: Option<BillReading>,
    pub proposal: BillProposal,                  // None once confirmed
    pub confirmed: Option<ConfirmedMatch>,
    pub ai: AiReadOffer,
    pub added_from_line: Option<String>,
    pub note: Option<String>,                    // e.g. "This invoice's total doesn't match that payment."
}
pub struct BillReading {
    pub fields: BillFields,
    pub assessment: BillAssessment,
    pub messages: Vec<CheckMessage>,             // the server's plain sentence for each failed check
    pub read_at: String,
}
pub struct CheckMessage { pub name: CheckName, pub message: String }
pub struct MatchLine {
    pub bank_line_id: String,
    pub account_name: String,
    pub date: NaiveDate,
    pub amount: Money,
    pub description: String,
    pub evidence: Vec<MatchEvidence>,            // name | invoice_number | added_from_here
}
pub enum MatchEvidence { Name, InvoiceNumber, AddedFromHere }
pub enum BillProposal {
    None,
    One { lines: Vec<MatchLine> },
    Candidates { sets: Vec<Vec<MatchLine>> },
}
pub struct ConfirmedMatch { pub lines: Vec<MatchLine>, pub confirmed_at: String, pub release: Release }
pub enum Release {
    Claimed,                                     // confirm_supply_info ran on at least one line
    WaitsForCoding,                              // confirmed, claimed when the line is sorted
    NotNeeded,                                   // every line $200 or less
    Short { ask_for: Vec<CheckName> },
    NoGstCharged,
}
pub enum AiReadOffer {
    NotNeeded,                                   // a passing reading from stage 1, or confirmed
    Offered { line: String },                    // the button and its line (D2), provider filled in
    GuestLocked,                                 // "Save your work to read invoices with AI"
    CantSend,                                    // "Take a photo of it or save it as an image"
    Off,                                         // no reader configured, the gate (D3) or the AI switch
}
pub struct BillConfirmed {                       // on Accepted, for confirm_bill
    pub release: Release,
    pub tax_before: Money,
    pub tax_after: Money,
}
pub struct BillList { pub bills: Vec<BillSummary> }   // newest first
pub struct BillSummary {
    pub id: String,
    pub file_name: String,
    pub status: BillStatus,
    pub supplier_name: Option<String>,
    pub total: Option<Money>,
    pub date: Option<NaiveDate>,
    pub verdict: Option<BillVerdict>,
    pub line_ids: Vec<String>,                   // confirmed lines, or a One proposal's
    pub proposed: bool,                          // line_ids are a proposal, not confirmed
}
```

- **The upload** returns `BillView`. A refused file is an ordinary `CommandError` (422) with its own
  code: `bill_type`, `bill_too_large`, `bill_too_many_pages`, `bill_encrypted`, `duplicate_bill`,
  `bill_space` (4), `bill_limit` (10).
- **Read this with AI** takes an empty body and returns `BillView`, with the new reading. Its errors:
  - `guest`;
  - `ai_off` (no reader, the gate, or the switch);
  - `bill_cant_send`;
  - `bill_confirmed`;
  - `ai_daily_limit` and `ai_budget`, worded for invoices, with no cost;
  - `ai_unreadable` ("The AI couldn't read this one. Try a clearer photo.") for a declined or invalid
    reply;
  - `ai_failed` for a network or provider error.
- **The list** takes `?line=<bank_line_id>`, to show the bills on one line.

The fields stay as they were read, with one exception: the owner may answer the fields OCR flagged as
unclear (`fill_bill_fields`, 13). There's no other editing of a reading: a misread bill is read with
AI, or deleted and added again. *Reason: an owner who can type any field can make up an invoice;
answering what a blurred bit of a kept page says is transcription, and anyone can look at the page.*

### 10. Limits
- **AI reads** are a third kind in M22's table, `invoice_read`, per business per UTC day, metered by
  `Metered` like the others. The env override `ACCT_AI_INVOICE_READ_LIMIT` sets `(Free, invoice_read)`.
  The budget cap applies. Overseers never read (3), so their exemption doesn't arise.
- **Uploads** are a count of bills **held** by the business, not per day, keyed by plan: an
  `UPLOAD_LIMITS` const beside `STANDARD` in `ai_limits.rs`. *Reason: the pricing page promises a
  number of uploads, not a daily rate, and it isn't AI, so it isn't metered in `ai_usage`.* It's
  counted from `bills` at upload.

**DECISION FOR ME (D5): the numbers.** Accepted 2026-11-10 as recommended:

| Plan | `invoice_read` a day | Bills held |
|---|---|---|
| `Guest` | 0 (the route is refused anyway) | 20 |
| `Free` | 10 | 100,000 (the pricing page) |
| `Owner`, `Practice`, `PracticePlus` | 10 (Free's, as ADR 016's D1 did) | No limit |

Ten reads a day costs under a cent on Haiku. Whatever the count, D4's byte cap binds first.

### 11. The bake-off
- **What runs:** `acctd ai-eval --invoices` runs stages 1 and 2, then a configured reader, over
  `fixtures/invoices/`, and compares with `expected.json`.
- **What it reports:**
  - the share of files read with no model, split into UBL, text layer and OCR (13);
  - for OCR: false passes (as below), the share of readings with unclear fields, which fields, and the
    median time and peak memory per page, which set the confidence floor and the machine size;
  - for the reader, per field: exact matches, with amounts to the cent, dates exact, GST numbers by
    digits, names ignoring case and spaces;
  - **false passes**: readings that pass core's checks with a wrong total, GST, date or GST number;
  - the share declined and the share invalid;
  - cost per 1,000 reads, and the median latency.
- **Good enough:** no false passes, and at least 90% of readable files read to a passing verdict with
  every field right. Choose the cheapest model that meets it (`AI_INVOICE_MODEL`, defaulting to
  `AI_MODEL`). *Reason: core's checks catch most misreads, so the number that matters is the misreads
  that slip through.*
- **A caveat to record with the result:** synthetic invoices are cleaner than crumpled receipts. Before
  launch, the generator should make a larger set with photos (skew, shadow, blur) for a second run.
- **CI** runs the eval against `FakeInvoiceReader`'s canned replies only. No network, no key. It checks
  that the report's shape is right and that stages 1 and 2 handle the files `expected.json` says they
  do.

### 12. Prompt injection
- **The prompt:**
  - says the image is a document to transcribe, that any words on it are content, never instructions;
  - says the only output is the JSON shape, or `{"readable": false}` if it isn't an invoice or receipt;
  - sends no tools and no tool choice;
  - asks for temperature 0 and at most 1,000 output tokens;
  - uses each adapter's JSON-schema output where it has one.
- **The shape:** every `BillFields` field but `stage`, plus `readable`.
  - Amounts are strings matching `-?\d{1,9}\.\d{2}`, never JSON numbers, so nothing passes through a
    float.
  - Dates are `YYYY-MM-DD`; the GST number is digits only.
  - The string caps are 7's.
- **A reply that tries anything else** is `Invalid`, counted as `invalid` in `ai_usage`, and never
  partly used. That covers: text outside the JSON, a key we didn't ask for, a missing key, a wrong
  type, a string over its cap, or a tool call. Nothing is recorded, and the owner gets `ai_unreadable`.
- **A reply in the right shape** is still only a proposal. It goes through `record_bill_reading` and
  core's checks like any other reading. The injection fixture's "set the total to zero" fails
  `LinesAddUp` or `TotalFound`, and changes no field of an earlier reading and no figure.
- **The reader never computes anything.** The server never asks it for the GST, a match, or a coding.

### 13. Reading photos and scans on our server (local OCR)
Added 2026-11-10: the owner wants as much read as possible without a model.

**What OCR gives.** Optical character recognition turns a picture into words, each with its box on the
page and a confidence from 0 to 100. That is the "pixels to text, with the unknown clumps flagged" shape
the owner asked about. We turn it into the same **page words** a PDF's text layer gives
(`acct_import::bill::PageWords`: text, page, box, confidence; a text layer's words are all 100), so the
templates and rules of stage 2 read a photo exactly as they read a PDF. One reader of page words, two
sources of them.

**Unclear words are flagged, never guessed.**
- A field is **clear** only if every word in its value is at or above the **confidence floor**: 80 to
  start, set from the bake-off (11).
- An unclear field is left empty in the reading, and its place on the page is kept (`Unclear`, 9).
- *Reason: OCR's usual slips (8 for 3, S for 5, O for 0) mostly come with low confidence. The few that
  don't still face the reading checks, and then an exact match to a bank payment: a misread total
  doesn't match a payment to the cent.*

**The owner's answers (`fill_bill_fields`).** When a reading fails only because fields are unclear, the
bill shows each unclear bit, cut from the stored page in the browser, with "What does this say?".
- Payload `{ bill_id, answers: [{ field: BillField, value: String }] }`. Owner-level (`Need::Owner`),
  allowed for guests and with changes on while viewing as someone: nothing leaves the server.
- Only a field the reading marks unclear can be answered. A field that wasn't found at all can't be
  typed in. *Reason: answering what's on the page is transcription; typing what isn't there is making
  up an invoice (9).*
- The answered fields are listed in `typed`. Core runs every check again on the whole reading, and a
  failing result is kept with its failures named, as in 2. A field the owner typed passes or fails the
  same way as one that was read.
- The accountant view shows "typed by [name]" beside each answered field, and Changes says "answered 2
  unclear fields on the invoice from Kōwhai Electrical".
- Not offered for UBL or a text layer, where nothing is unclear.

**When Read this with AI is offered** (D1's page image, only when pressed): OCR found no total, or
fewer than 20 clear words, or the reading still fails after the owner's answers, or OCR isn't
available. So an owner with a clear photo never sees the button.

**Sending only the unclear bits to the AI** (crops, with the rest read locally) was considered. It
exposes less than the whole page, but it needs an image decoder on the server to cut the crops, a
second line on a second button, and a second message to IRD. The owner's answers cover the same
ground for free. That's D7.

**DECISION FOR ME (D6): the OCR engine. Accepted 2026-11-10: A.**
- **A. Tesseract 5, run as its own program (recommended).** Apache 2.0. Debian packages it
  (`tesseract-ocr`, with `tesseract-ocr-eng`, plus `tesseract-ocr-mri` for macrons: **check** the
  package names and sizes). Its TSV output gives each word's box and confidence. *Reason: the most
  accurate free engine on printed text, its per-word confidence is what flagging needs, and as a
  separate process a crash or a hostile image can't take the server down.*
- B. `ocrs`, pure Rust, no system package, so `acct-dev` on Windows gets it free. Newer and less proven
  on receipts, and we'd have to check that it reports per-word confidence; without that nothing can be
  flagged.
- C. No OCR in M23 (the plan before 2026-11-10).

**How it runs (with A):**
- **After the upload, not during it.** The upload records the bill and returns at once with status
  `Reading`. A worker in `acctd` reads it and submits `record_bill_reading` as the uploader; the web
  sees that through `/api/sync`, as it sees any change. On start, the server queues every image or scan
  with no reading. *Reason: a few seconds a page is too long to hold a request on a phone.*
- **One at a time.** A queue with one worker. Tesseract reads the image from stdin and writes TSV to
  stdout: no temporary files, no file name. It's killed after 30 seconds a page and capped at 300 MB of
  memory (`prlimit --as`), and gets no network and no environment. A page past the limit is "not read
  yet", and AI is offered.
- **Pages:** the first 3. Page segmentation `--psm 1`, which also detects a page that's on its side
  (**check** that it needs `osd.traineddata`).
- **What it's given:** a JPEG or PNG we've already sniffed and capped (6). A scanned PDF page is read
  only if it's one full-page image: a JPEG (`DCTDecode`) is passed as it is; an 8-bit grey or RGB
  `FlateDecode` image is wrapped as a PNG. Anything else (fax `CCITTFax`, `JBIG2`, vector pages) gets
  "We can't read this scan. Take a photo of it instead." There's no PDF renderer. *Reason: pdfium is
  large, and MuPDF is AGPL.*
- **Photos the right way up.** The web app already redraws every photo through a canvas before upload
  (3), which turns it upright from its Exif. The server's metadata stripping (3) happens after that, so
  nothing is lost.
- **Memory:** production has 512 MB. One page at a time with a 300 MB cap is expected to fit beside
  `acctd`; the bake-off measures it, and if it's tight the machine goes to 1 GB (a `fly.toml` change;
  **check** the price).
- **Where it lives:** `crates/ocr` (`acct_ocr`), behind a `PageOcr` trait with a `FakeOcr` for tests,
  as every outside integration is (ADR 007). `acctd` uses Tesseract when `ACCT_OCR=tesseract` and the
  program is found; otherwise OCR is off and photos wait for AI, as before.
- **What's kept:** the fields and the unclear boxes. OCR's words are dropped once the reading is made
  (4).

**DECISION FOR ME (D7): the unclear bits. Accepted 2026-11-10: A.**
- **A. The owner answers them (recommended).** As above. Crops to the AI, revisited once the bake-off
  and real use show how often owners are asked. *Reason: free, private, a few seconds per field, and
  no new consent or IRD question.*
- B. Send only the unclear crops to the AI, when pressed, with the owner's answer as the fallback.
- C. Both offered side by side.

### 14. Purchases paid in parts (the $200 rule per supply)
**The rule.** The $200 and $1,000 tiers go by the value of the **supply**, not each payment. A $345.50
job paid as a $150.00 deposit and a $195.50 balance needs the over-$200 information before either
payment's GST is claimed. The tax specialist confirmed this, through the owner, on 2026-11-10. Today
core applies the threshold per bank line, which claims both payments' GST with no records. This
section closes that gap.

**The idea: a purchase.** A purchase is one or more money-out lines that pay for one supply, with that
supply's total. The threshold reads the purchase's total. In core (`acct_core::purchases`):

```rust
pub struct Supply {
    pub total: Money,                         // the supply's GST-inclusive value
    pub info_confirmed: Option<NaiveDate>,
}
impl Supply {
    pub fn of_line(line: &BankLine<'_>, info_confirmed: Option<NaiveDate>) -> Supply;  // today's rule
}
```

- `coding::coded_lines` and `coding::gst_totals` take `&Supply` in place of `supply_info_confirmed`, and
  test `supply.total > SUPPLY_INFO_THRESHOLD` in place of `spent > SUPPLY_INFO_THRESHOLD`.
- A line in no purchase passes `Supply::of_line`, which gives exactly today's postings: a property test
  says so.
- The GST claimed is still worked out on each line (3/23 of it), in that line's period. Only the test
  of whether it waits in 615 changes.

**Where a purchase comes from:**
1. **A bill** on more than one line, or part paid (7): the bill's total.
2. **The owner says so** (`group_payments`), from Save tax's card or the bank screen. They pick the
   payments, and give the full price if some of it was paid another way (cash, another card), so the
   total is at least what the lines add up to.
3. **A flag the owner answers "One purchase"** (below), which is the same command.

**Spotting them (`acct_core::purchases::possible_splits`).** Pure and worked out when it's read, like
matching (8), never stored.
- **Lines considered:** money-out lines of $200 or less, in no purchase, not duplicates or either half
  of a transfer, coded with standard GST or not coded yet. A line coded personal or without GST claims
  nothing, so it can't matter.
- **The same payee:** the description, normalised as in 8, without bank prefixes (`POS`, `EFTPOS`, `AP`,
  `DD`, `VISA`, `DEBIT`, card numbers and dates; core's list), shares its first remaining word of 3 or
  more letters.
- **Flagged** when the lines together come to over $200 and one of these holds:
  - *Same reference:* they share a number of 4 or more digits (an invoice or job number), within 60
    days.
  - *Instalment words:* one of them says `DEPOSIT`, `DEP`, `BALANCE`, `BAL`, `INSTALMENT`, `INSTAL`,
    `PART`, `FINAL`, or `1/2`, `2 OF 3` and the like, within 60 days.
  - *Same day:* two or more payments to the same payee on the same day (a purchase split across cards,
    or under a card limit).
  - *Split bills:* two or more bills from the same GST number, each $200 or less, together over $200,
    with the same date or invoice numbers one apart (**check** with the tax specialist: one supply
    split across invoices).
- **Not flagged:** regular payments with none of these signs. A weekly $80 at the same café, or monthly
  rent, never flags. *Reason: a false flag costs the owner a tap, but a flood of them teaches them to
  ignore the card.*
- **Deterministic:** strongest sign first (reference, words, same day, bills), then the earliest date;
  a line is in at most one flag.
- **Filing (D8):** each card carries `blocks_filing: true` while it covers a line in a period not yet
  filed. M14's Submit refuses while one is open; M23 only marks them.

**The card.** Save tax gains `CardKind::PossibleSplit`: "Were these one purchase?", listing the payments
and the sign ("Both mention 4471").
- **One purchase** → `group_payments`, with the total filled in from the lines and editable. If it's over
  $200, the card says first: "The GST on these waits until you have the invoice. Your tax to pay rises
  by $45.07." Then it offers Add invoice (M23).
- **Separate purchases** → `answer_possible_split`, kept in `split_answers` by business and the sorted
  line ids, so that exact set never flags again. A new statement can still make a new set that does.
- The existing `SupplyInfo` card shows one card per purchase, and `confirm_supply_info` on any line of a
  purchase confirms every line in it, in one command. Its payload doesn't change.

**DECISION FOR ME (D8): does a flag hold the GST before it's answered? Accepted 2026-11-10: A.**
- **A. No, but it must be answered before a GST return covering those lines is filed (recommended).**
  The figure moves only when the owner answers; Submit (M14) shows the card first. *Reason: postings
  change only through commands (hard rule 6), so a guess never moves tax or makes the figure and the
  books disagree, and no return reaches IRD with an open question that could make it wrong.*
- B. Hold the GST from the moment it's flagged. The most conservative figure, but it rises on its own
  when a statement is uploaded, and the figure and the ledger disagree until it's answered.

**Rules on a purchase** (core checks them; the command checks again):
- One or more lines, all this business's money-out lines, each in no other purchase, and none held by a
  confirmed bill other than this purchase's own.
- The total is at least what the lines add up to. One line with a larger total (part paid another way)
  is allowed.
- Every line within 365 days of the earliest.
- **A line in a finalised year is refused:** "That payment is in a finalised year. Ask your
  accountant." Grouping can raise the tax in a period already done, so that's the accountant's to
  correct. Once filing exists, a period already filed is refused the same way (**check** with the tax
  specialist how a correction should go).
- Making or ending a purchase reposts each coded line in it inside the command (reverse and repost, as
  `confirm_supply_info` does through `set_posting`).

**The commands:**

| Command | Payload | Stores | Changes figures |
|---|---|---|---|
| `group_payments` | `{ client_id, bank_line_ids, total }` | The purchase and its lines | Yes, when the total is over $200 and the information isn't confirmed: the lines' GST moves to 615 |
| `ungroup_payments` | `{ purchase_id }` | Removes it (refused for a bill's; unmatch the bill instead) | Yes, back to each line's own rule |
| `answer_possible_split` | `{ client_id, bank_line_ids }` | "Separate purchases" for that set | No |

- Each is owner-level, on `impersonation::ALLOWED` and `guests::GUEST_ALLOWED`, with a `describe` arm:
  "said 2 payments to Kōwhai Electrical (12 and 19 Mar) were one purchase of $345.50", "said 2
  payments to Kōwhai Electrical were separate purchases", "ended the purchase from Kōwhai Electrical".
- `Accepted` gains the tax before and after for `group_payments` and `ungroup_payments`, as for
  `confirm_bill`.
- Ending a purchase leaves any supply-information confirmation as it is (7's reason).
- `remove_statement` takes the lines it removes out of their purchases, and a purchase left with no
  lines goes. Guest expiry deletes purchases and answers.

**Reads:** `GET /api/businesses/{id}/purchases` (`Client(Need::Read)`) returns

```rust
pub struct PurchaseView {
    pub id: String,
    pub total: Money,
    pub paid: Money,                          // what its lines add up to
    pub lines: Vec<MatchLine>,                // evidence empty
    pub bill_id: Option<String>,
    pub info_confirmed: Option<NaiveDate>,
}
pub struct PossibleSplit { pub lines: Vec<MatchLine>, pub sign: SplitSign, pub blocks_filing: bool }
pub enum SplitSign { SameReference { digits: String }, InstalmentWords, SameDay, SplitBills }
```

and the bank screen marks a line in a purchase "1 of 2 payments towards $345.50".

## Consequences
- **Migration `0017_bills.sql`** (Agent 9; the next free number if 0017 is taken; M24 has 0018):
  - `bills`: id, client_id, file_name, media_type, sha256, size_bytes, pages, has_text_layer, bytes,
    added_from_line, auto_match, added_seq, added_by. `UNIQUE (client_id, sha256)`.
  - `bill_readings`: one per bill. The stage, the fields (with `unclear` and `typed`) and the assessment
    as JSON, the verdict, the seq.
  - `bill_matches`: `(bill_id, bank_line_id)`, with the seq. `UNIQUE (bank_line_id)`, so a line backs
    at most one confirmed bill.
  - `bill_templates`: `(client_id, supplier_key)`, the layout as JSON, the seq.
  - `purchases` (14): id, client_id, total, bill_id (`UNIQUE`, nullable), created_seq.
  - `purchase_lines`: `(purchase_id, bank_line_id)`. `UNIQUE (bank_line_id)`, so a line is in at most
    one purchase.
  - `split_answers`: `(client_id, lines_key)` primary key, the answer's seq. `lines_key` is the sorted
    line ids joined.
  - `ai_usage` rebuilt with `kind` allowing `invoice_read` (SQLite can't alter a `CHECK`): new table,
    copy, drop, rename, indexes again.
- **Commands (nine):** `attach_bill`, `record_bill_reading`, `confirm_bill`, `unmatch_bill`,
  `delete_bill`, `fill_bill_fields` (13), `group_payments`, `ungroup_payments`, `answer_possible_split`
  (14). Each needs:
  - an `access::command_targets` rule (`Need::Owner`, the bill's, line's or purchase's business);
  - a `describe` arm in `history.rs`;
  - a place on `impersonation::ALLOWED` and `guests::GUEST_ALLOWED`;
  - `attach_bill` and `record_bill_reading` on the new `commands::SERVER_ONLY`.
- **Core's GST rule changes** (14): `coded_lines` and `gst_totals` take `&Supply`. Every caller
  (`save_tax.rs`, the coding commands, the GST return) looks up the line's purchase. A property test
  shows `Supply::of_line` gives today's results.
- **`remove_statement`** deletes `bill_matches` and `purchase_lines` rows on the lines it removes;
  `expire_guest` deletes bills, purchases and split answers. ADR 014's table comparison picks up the
  new tables.
- **Routes:** the five in 9, with `RouteRule::Bill(Need)`, and the purchases read in 14.
  - `while_acting`: upload `NeedsChanges`, AI read `Refused`.
  - `guests::route_allowed`: all but the AI read.
  - The upload route gets its own body limit.
- **Save tax:** `CardKind::PossibleSplit`; `SupplyInfo` cards per purchase; Submit shows open
  `PossibleSplit` cards for the period first (D8).
- **Guests:** bills count towards the 5 MB and 200 MB holdings, and 20 bills each.
  `guests::check_holding` sums statement files and bills.
- **Crates:**
  - `acct_core::bill`: types, checks, checksum, matching.
  - `acct_core::purchases`: `Supply`, the purchase rules, `possible_splits`.
  - `acct_import::bill`: sniff (with metadata stripping), page words, UBL, PDF text, scanned-page image
    extraction, templates.
  - `acct_ocr` (new, `crates/ocr`): the `PageOcr` trait, the Tesseract runner, `FakeOcr`.
  - `acct_ai::bill` and `bill_fake`: the `InvoiceReader` trait, the request, the prompt, the parser.
  - `crates/server`: `bills.rs` (commands, reads, types), `bill_reading.rs` (the routes), the OCR worker,
    and `purchases.rs`.
- **Metering:**
  - `Metered` gains a private `reader: Option<Arc<dyn InvoiceReader>>` and `Ask::read_invoice`;
  - `AiKind::InvoiceRead` is added;
  - the source check also fails on `InvoiceReader` or `.read_invoice(` outside `ai_usage.rs` and
    `main.rs`.
  - OCR isn't metered: it's local and free.
- **New dependencies:** for PDF text, page count and embedded-image extraction, one pure-Rust crate
  (Agent 6 checks maintenance and licence; `lopdf` is the first to look at). For UBL, an XML reader
  such as `quick-xml`, with DTDs refused. To wrap a scanned page's Flate image as a PNG, the `png`
  crate. No image decoder in Rust.
- **The image** (`Dockerfile`): `tesseract-ocr`, `tesseract-ocr-eng` and `tesseract-ocr-mri` in the
  runtime stage (D6). CI installs them too, for one test on a synthetic photo; every other test uses
  `FakeOcr`. `acct-dev` on Windows runs with OCR off unless Tesseract is installed.
- **ts-rs types:** everything in 9 and 14, plus `AiKind::InvoiceRead`, `CardKind::PossibleSplit` and
  `Accepted.bill`. Run `make types`.
- **Config:** `AI_INVOICE_MODEL`, `ACCT_AI_INVOICE_READS`, `ACCT_AI_INVOICE_READ_LIMIT`, `ACCT_OCR`.
- **Docs:**
  - `docs/domain.md` has the "Tax invoices" section, with "Purchases paid in parts";
  - `docs/security.md` has the new rows (Planned, M23);
  - `NON-CODE-TODOS.md` has the new items.
- **Changes to the milestone's prompts:** the ADR wins where they differ.
  - `record_bill_reading` records a failing reading; `confirm_bill` refuses it (2).
  - No matching call from the statement import (8).
  - The fields gain `buyer_detail`, `currency`, `lines_include_gst`, `says_gst_included`, `unclear` and
    `typed`, each needed by a rule in 1 or 13. The total is optional, so a reading that missed it can
    be recorded.
  - Agent 2's renamed file should be a type we refuse (6). Agent 2 also makes a few photos and scans
    of the synthetic invoices (one blurred enough to leave a field unclear), and a pair of deposit and
    balance payments in a statement.
  - OCR (13) and purchases (14) were added to `M23-PROMPTS.md` on 2026-11-10, and its agents were
    renumbered: purchases in core is Agent 4, OCR Agent 7, the purchase commands and cards Agent 11, and
    their screens Agent 13.
- **For the tax specialist** (`NON-CODE-TODOS.md`): the tiers, the allowance, the IRD-number checksum,
  bills split across invoices (14), and how a purchase that reaches back into a filed period should be
  corrected.

## The owner's decisions
- **D1.** What stage 3 sends. **Accepted 2026-11-10:** the page image, metadata stripped, only when
  pressed.
- **D2.** The line on Read this with AI. **Accepted 2026-11-10** as drafted in 3.
- **D3.** What has to be done before real owners use stage 3. **Accepted 2026-11-10:** IRD's written
  confirmation and the privacy policy, with ZDR not required; enforced by `ACCT_AI_INVOICE_READS`.
- **D4.** Space. **Accepted 2026-11-10:** the database now, 4 MB a file, 100 MB a business, a 70% volume
  guard, and object storage before the 100,000 promise matters.
- **D5.** The limits. **Accepted 2026-11-10:** 10 AI reads a day on every plan, guests none; 100,000
  bills held on Free, no limit on paid plans, 20 for a guest.
- **D6.** The OCR engine (13). **Accepted 2026-11-10:** Tesseract 5, run as its own program.
- **D7.** The unclear bits (13). **Accepted 2026-11-10:** the owner answers them; crops to the AI later,
  if at all.
- **D8.** A flagged possible split before it's answered (14). **Accepted 2026-11-10:** no GST held, but
  it must be answered before a return covering it is filed. Filing is M14, not built yet, so M23 marks
  those cards `blocks_filing` and M14's Submit refuses while one is open.
