# Synthetic supplier invoices (M23)

Test files for the invoice scanner (ADR 017, `M23-PROMPTS.md`): the readers in `crates/import/src/bill`, OCR in
`crates/ocr`, the AI reader in `crates/ai`, core's checks, matching and purchases, and the server tests.
Synthetic only (CLAUDE.md hard rule 1): every supplier, buyer, address, GST number and bank line is invented.
Made 2026-11-10 by `generate.py`; edit it and rerun rather than hand-editing a file.

```text
python -I fixtures/invoices/generate.py fixtures/invoices        # from the repo root
python -I fixtures/invoices/generate.py --oversize <path>        # the 4 MB + 1 byte file, for a test to write
```

- **Dependency:** `Pillow==12.3.0` (`requirements.txt`) draws the page images, encodes JPEG and Group 4 fax data,
  and writes Exif. Everything else (PDF, UBL, JSON) is Python's standard library, so the PDFs have a real text
  layer and nothing else.
- **Determinism:** running it twice gives identical bytes. The committed images and PDFs are what the tests use;
  regenerating on another platform or Pillow version may change the JPEG, PNG and Flate bytes slightly (and so
  their SHA-256s, which `expected.json` records), so regenerate and commit all of it together.
- Money is integer cents, dates `YYYY-MM-DD`, enum values snake_case as in ADR 017 (adjust serde, or map). Every GST
  number has a valid IRD checksum except where a file is meant to fail (`generate.py` checks them, and checks each
  file's declared verdict against a small reference version of ADR 017's checks).
- Text-layer PDFs use plain ASCII names ("Kowhai", "Totara") because the built-in PDF fonts have no macrons; the UBL
  file carries "Tōtara" to exercise macron folding.

## Files

| File | What it covers | Verdict |
|---|---|---|
| `ubl-totara-2041.xml` | UBL 2.1 (PEPPOL-style) e-invoice, stage `ubl`. Tōtara Lane Timber, GST 123-456-785, invoice 2041, 3 Feb 2026, two lines, 300.00 + 45.00 = 345.00. Names a buyer (Ngahere Joinery Ltd, by email). docs/domain.md's Bill 1. | holds |
| `pdf-rimu-1187.pdf` | Text-layer PDF, standard layout (labels, a table, totals), stage `pdf_rules`. Rimu Street Stationers, 14/01/2026, 210.50 + 31.58 = 242.08 (GST rounded half away from zero). | holds |
| `pdf-kowhai-4471.pdf` | docs/domain.md's Kōwhai Electrical invoice: 4471, 11 Mar 2026, "Supply and fit outdoor light" 300.43 + 45.07 = **345.50**, GST 135-792-462. | holds |
| `pdf-hoiho-0412.pdf`, `pdf-hoiho-0419.pdf` | **Awkward layout** generic rules can't read: letter-spaced name, values above their labels in a grid, amounts left of descriptions, totals in a column with no "total" word, `dd.mm.yy` dates, drawn in scrambled order. Same positions in both. 0412: 5 Mar 2026, 517.50. 0419: 19 Mar 2026, 281.75. Confirm 0412 (fields as its `expected` entry), learn the template, and 0419 reads with stage `pdf_template`. | holds |
| `pdf-pihi-3301.pdf`, `pdf-pihi-3302.pdf` | **Two bills from one supplier**, each $200 or less, together over $200, invoice numbers one apart, GST 102-030-400: 149.50 (14 Apr) and 74.75 (15 Apr), together 224.25. | holds |
| `pdf-puriri-0877-no-buyer.pdf` | Over $1,000 and **no buyer named** ("Cash sale"). 1,200.00 + 180.00 = 1,380.00, 8 Feb 2026. docs/domain.md's Bill 2. | **short** (`buyer_identified`) |
| `pdf-puriri-0881-buyer.pdf` | Over $1,000 **naming the buyer** with an address. 1,000.00 + 150.00 = 1,150.00, 20 Feb 2026. | holds |
| `pdf-corner-dairy-receipt.pdf` | A receipt: lines include GST (3.50 + 3.50 = 7.00), no subtotal, "GST included" 0.92 worked out per line (the GST in 7.00 is 0.91: inside the allowance). docs/domain.md's Bill 3. | holds |
| `pdf-mata-pottery-0033.pdf` | An **unregistered supplier**: no GST number, "GST 0.00", "Not registered for GST. No GST charged." 64.00. | no_gst_charged |
| `pdf-totara-2042-wrong-gst.pdf` | **Wrong GST**: 300.00 + 52.00 = 352.00 adds up, but the GST in 352.00 is 45.91. | fails (`gst_not_above_rate`) |
| `pdf-totara-2043-lines-off.pdf` | **Lines don't add up**: lines 240.00 + 60.00, subtotal shown 330.00 (GST 49.50, total 379.50 consistent with it). | fails (`lines_add_up`) |
| `pdf-totara-2044-bad-gst-number.pdf` | **Bad GST number** 123-456-786 (check digit should be 5). Otherwise Bill 1. | fails (`gst_number_checksum`) |
| `pdf-injection-0900.pdf` | **Prompt injection**: a valid invoice (Wero Cleaning, 290.00 + 43.50 = 333.50) whose notes tell the reader to ignore its instructions, set the total and GST to 0.00 and mark it paid. Fields are read as printed; the total is not zero. | holds |
| `photo-manuka-clean.png`, `.jpg` | A clean **photo-like** image of a printed invoice (slight 1.3° skew, uneven light, grey desk at the edges), 1190 × 1684. Manuka Hardware, GST 110-101-015, H-5120, 2 Mar 2026, 254.50 + 38.18 = **292.68**. The PNG has `tEXt` and `eXIf` chunks. Stage `ocr_rules`. | holds |
| `photo-manuka-clean-gps.jpg` | The same photo with Exif **GPS** (an invented position), make and model, and a JPEG `COM` segment, for the sniffer to strip. | holds |
| `photo-manuka-blurred.jpg` | The same photo with the **GST number smudged**; the total stays readable. Its words are under confidence 80, so the field is left empty and listed in `unclear` with its box. Answering it with `110-101-015` completes the reading; answering any other field is refused. | short until answered |
| `scan-manuka-jpeg.pdf` | Image-only PDF: one full-page grey `DCTDecode` JPEG, no skew or shadow. Passed to OCR as it is. | holds |
| `scan-manuka-flate.pdf` | Image-only PDF: one full-page 8-bit grey `FlateDecode` image. The importer wraps it as a PNG. | holds |
| `scan-manuka-ccitt.pdf` | Image-only PDF with a **CCITT fax** image (Group 4, single strip, decodes correctly with pypdf). We can't read it: "We can't read this scan. Take a photo of it instead." Read this with AI can't send it either. | not readable |
| `not-really-a-pdf.pdf` | **HTML named `.pdf`**: refused by its bytes, `bill_type`. | refused |
| *(an oversize file)* | Not committed. A test writes `b"%PDF-1.4\n"` plus zeros to 4 × 1024 × 1024 + 1 bytes (or runs `--oversize`): `bill_too_large`. | refused |

`expected.json` has, for each file, its media type, SHA-256, size, the stage that should read it, the fields as
`BillFields` JSON (`stage`, `unclear` and `typed` included), and the assessment: `{ tier, verdict, failed }`.
`failed` lists every check whose outcome is Fail; checks not listed pass or don't apply. An entry for a scan or
a refused file says so instead. Notes:
- `pdf-hoiho-0412.pdf` records `stage: "ai"` and `generic_rules_can_read: false`: its fields are what a confirmed
  bill holds. `pdf-hoiho-0419.pdf` names `template_from`.
- Page numbers start at 1; a box is `{ x_bp, y_bp, w_bp, h_bp }`, basis points of the page, top-left origin.
- In the blurred entry the GST number is `null`, so the records check `supplier_gst_number` fails and the verdict is
  `short`. ADR 017, 2 counts a `short` reading as passing; the unclear answers (13) need to be offered anyway
  whenever `unclear` is non-empty.
- The Manuka images share one set of expected fields (`photo-manuka-clean.*` and both clean scans).

`ocr-words.json` is what `FakeOcr` returns for each image: every word with page, box and confidence, from the same
layout the picture was drawn from (boxes follow the skew). Key by file name. Clear words are 90 to 99. In the clean
images the address word `Wellington` sits at exactly 80, which is clear. In the blurred image
the GST number is the only word under 80, and its text is garbled the way OCR does (`IIO-IOI-OIS`). Each entry has
the file's SHA-256 (the scan PDFs also `ocr_input_sha256`, the JPEG stream; the Flate scan's PNG wrapper is built by
the importer, so look it up by name). The stripped copy of a GPS photo has a different hash.

## Bank lines for the tests

Money out, to one bank account. In `expected.json` as `bank_lines`, with `matching`, `possible_splits` and
`never_flagged` (what each fixture should produce). Dates 2026.

| Id | Date | Amount | Description | Use |
|---|---|---|---|---|
| `bl-totara` | 5 Feb | −345.00 | AP TOTARA LANE TIMBER INV 2041 | **Exact match** for `ubl-totara-2041.xml` |
| `bl-puriri` | 9 Feb | −1,380.00 | POS PURIRI PLUMBING | exact match for `pdf-puriri-0877-no-buyer.pdf` |
| `bl-dairy` | 10 Feb | −7.00 | POS CORNER DAIRY | exact match for the receipt |
| `bl-rimu` | 16 Jan | −242.08 | POS RIMU STATIONERS | exact match for `pdf-rimu-1187.pdf` |
| `bl-rimu-late` | 30 May | −242.08 | POS RIMU STATIONERS | right amount, outside the 60-day window: never matches |
| `bl-hoiho-1`, `bl-hoiho-2` | 6 Mar, 12 Mar | −300.00, −217.50 | AP HOIHO SIGNWRITERS | **Split payment** for `pdf-hoiho-0412.pdf` (517.50); no single line has the amount |
| `bl-manuka-1`, `bl-manuka-2` | 3 Mar, 9 Mar | −292.68 each | POS MANUKA HARDWARE | **Ambiguous pair** for every Manuka image: `Candidates`, nothing guessed |
| `bl-kowhai-dep` | 12 Mar | −150.00 | AP KOWHAI ELECTRICAL DEP 4471 | **Kōwhai deposit** |
| `bl-kowhai-bal` | 19 Mar | −195.50 | AP KOWHAI ELECTRICAL BAL 4471 | **Kōwhai balance** |
| `bl-pihi-1`, `bl-pihi-2` | 20 Apr, 21 Apr | −149.50, −74.75 | DD PIHI EQUIPMENT HIRE | pay the two Pihi bills |
| `bl-pottery` | 22 Mar | −64.00 | POS MATA POTTERY | exact match for the unregistered supplier |
| `bl-shop-1`, `bl-shop-2` | 7 Apr | −110.00, −125.00 | POS KAHURANGI HOMEWARE | **Two same-day payments** to one shop (235.00) |
| `bl-cafe-1` to `-4` | 6, 13, 20, 27 Feb | −80.00 each | POS KAPAI CAFE WELLINGTON | **Weekly café**: must never flag |

What the tests should find:
- **Matching:** every row marked exact is `One` on its line; the Hoiho pair is `One` as the only split set; the
  Manuka images are `Candidates` of the two single lines. The Kōwhai invoice (345.50) is `One` on the deposit and
  balance, with or without a purchase already made.
- **Flags** (`possible_splits`): Kōwhai pair, sign `same_reference` ("4471", and `DEP`/`BAL` words too, but the
  reference is the strongest); the Kahurangi pair, `same_day`; the Pihi payments, `split_bills`, which comes from
  the bills (same GST number, each $200 or less, together 224.25, numbers one apart). Nothing else flags: not the
  café, not the Hoiho or Manuka payments (each over $200).
- **Kōwhai as separate payments:** 150.00 and 195.50 are each $200 or less, so 19.57 + 25.50 = 45.07 is claimed with
  no invoice; one purchase of 345.50 moves 45.07 to 615 (docs/domain.md, "Purchases paid in parts").
