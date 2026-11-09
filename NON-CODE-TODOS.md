# Non-code to-dos

Everything a person has to do outside the code: checks, approvals, applications and decisions. Code
tasks live in `PLAN.md`. Tick an item (`[x]`) and add the date when it's done. Gathered 2026-10-24.

## IRD business track (start now; gates M14)
IRD's approval has its own review steps, so start early.
- [ ] Register the organisation for gateway services in IRD's Gateway Customer Support Portal. IRD then
      reviews business alignment, the tax compliance and integrity of the organisation and its key
      people, and our security through the Operational Security Framework (OSF) questionnaire (aligned
      with ISO 27001, and repeated every year).
- [ ] Product requests: the Return service (GST and income tax), and the access services owners use to
      authorise us with their myIR sign-in.
- [ ] In the business alignment review, lead with getting returns filed on time with less effort; the
      conservative starting figure errs towards overpaying.
- [ ] Once approved: accept the gateway terms of use, get developer portal and test environment access,
      and read the build packs. Record anything they require on screen (declaration wording, consent, IRD
      messages) in `docs/ird.md`.
- [ ] Customer terms and a privacy policy, including consent to file for the owner. IRD can ask for
      evidence of that consent. The privacy policy names the AI provider as a subprocessor and says what
      it's sent (ADR 011), since there's no longer a consent screen for AI suggestions. Accepting the
      terms at sign-up should be recorded as a command, so it's the evidence IR1269 4(h) and 4(i) ask for.
- [ ] Have a privacy lawyer check ADR 011's reading: that a generalised AI request isn't personal
      information, so the privacy policy is enough and no consent screen is needed.
- [ ] Customer terms and privacy policy: say that our support staff (overseers) may view an account as
      its user to help them (ADR 013, M19). It's read-only unless changes are needed, at most 30 minutes
      at a time, never used to sign off a year or deal with IRD, logged with a reason, and shown to the
      user in their own Changes and in a notice the next time they open the app.

## AI suggestions (ADR 009, ADR 011): before real owners get them
Development with synthetic data isn't affected. Suggestions are on by default with no consent screen
(ADR 011), so none of this can be skipped: real owners mustn't get suggestions until the generaliser
ships.
- [ ] Decide whether to accept ADR 011's generaliser (it's "proposed"), after the bake-off compares it
      with ADR 009's redaction.
- [ ] Ask our IRD account manager to confirm in writing that sending generalised bank lines to an AI
      provider is acceptable (ADR 009, "IRD's position"; ADR 011, "IRD"). Do this as part of the
      business track.
- [ ] Apply to Anthropic's sales team for zero data retention. ZDR doesn't cover the Batch API or prompt
      caching, so decide then whether to give up those discounts. If the retention period changes, update
      the privacy policy.
- [ ] List Anthropic as a subprocessor in `docs/security.md` (M12) and in the OSF answers.
- [ ] Someone with accounting knowledge checks the labels in `fixtures/ai/labelled-lines.json` (category
      and GST code per line). Fix them in `tools/ai-labelled-lines/generate.py` and rebuild.
- [ ] Run the bake-off with real API keys (it costs a few cents): `AI_PROVIDER=anthropic AI_API_KEY=...
      acctd ai-eval`, then try other models with `AI_MODEL`. Choose the production model and record it in
      ADR 009.

## AI monitoring and invoice scanning (M22, M23)
- [ ] M22: decide whether free-form AI question text may ever be kept (for investigating abuse), and for
      how long. The starting position in the plan is no: counts and cost only. If yes, the privacy policy
      says so.
- [ ] M22: set the daily AI budget cap in cents for staging and production (`ACCT_AI_DAILY_BUDGET_CENTS`),
      and the per-plan, per-kind daily limits.
- [ ] M22: check the AI usage view in a browser as an overseer, and that a spike is flagged.
- [x] M22: accept ADR 016 and answer its decisions D1 to D6. Done 2026-11-09: every recommendation
      accepted.
- [ ] After M22: build the daily delete of `ai_usage` rows older than 400 days (ADR 016, D3).
- [ ] M22: privacy policy: say that each AI request is counted against the business and user who made it
      (when, which feature, tokens, cost and whether it worked), that what was asked and answered is never
      kept, and how long the counts are kept (ADR 016, D3).
- [ ] M22: fix `docs/security.md`'s "no AI for guests" lines ("What never leaves" and the guests row):
      since M21, guests can use Explain better within their own daily limit.
- [ ] M23: someone with accounting knowledge checks which tax invoice fields are required at which
      amounts ("Tax invoices" in `docs/domain.md`, marked **check**), and the GST rounding allowance.
- [ ] M23: ask our IRD account manager to confirm in writing that sending an owner's invoice image or
      text to an AI provider is acceptable (as for ADR 009). Stages 1 and 2 don't need it.
- [ ] M23: ZDR from Anthropic should cover invoice reads too; update the privacy policy to say invoices
      can be sent to the provider when the owner asks.
- [ ] M23: decide the per-plan limit on AI invoice reads.
- [ ] M23: check the invoice scanner in a browser on a desktop and on a phone with a real camera photo of a
      synthetic invoice. Never a real client's.
- [x] M23: decide ADR 017's D1 to D5 (what an AI read sends, the line on the button, what has to be done
      before real owners get AI reads, where bill files are kept and how much space each business gets,
      and the read and upload limits). Done 2026-11-10: every recommendation accepted.
- [x] M23: decide ADR 017's D6 to D8 (the OCR engine, what happens to the bits OCR can't read, and
      whether a possible split payment holds GST before it's answered), then mark the ADR accepted before
      wave 2 of `M23-PROMPTS.md` starts. Done 2026-11-10: every recommendation accepted; ADR 017 accepted.
- [ ] M23: before real owners can read invoices with AI, tell IRD in advance that invoice pictures can now
      go to the AI provider (IR1269 5.2(b): unlike ADR 011's generalised lines, a picture can identify the
      taxpayer), add it to the OSF answers, and then set `ACCT_AI_INVOICE_READS=on` in production
      (ADR 017, D3).
- [ ] M23: privacy policy, invoices: what's kept (the file, with photo location data stripped, and the
      fields read from it), for how long, that e-invoices and PDFs with text are read on our server, and
      that a picture of the page goes to the AI provider, overseas, only when the owner presses Read this
      with AI. Invoices name other people (suppliers, sometimes staff), and we use those names only to
      keep the owner's records.
- [ ] M23: customer terms: whether an owner may rely on our copy of an invoice as their GST record (IRD
      asks for 7 years), or should keep their own too. Have the tax specialist confirm that a phone photo
      of a paper invoice, kept by us, is an acceptable record. Decide with M18's statement-file item below.
- [ ] M23: include bill files in the offshore storage application if production stays in Sydney (M12
      security, below).
- [ ] M23, for the tax specialist: check the IRD-number check-digit rule in "Tax invoices" in
      `docs/domain.md` against IRD's current specification. The gap it used to note (the $200 threshold
      applied per payment) is answered: the specialist confirmed on 2026-11-10 that it goes by the supply,
      and ADR 017, 14 closes it.
- [ ] M23, for the tax specialist: "Purchases paid in parts" in `docs/domain.md`. Check the worked
      example; whether one supply split across several invoices of $200 or less counts as one supply; and
      how to correct a purchase that reaches back into a finalised year or a filed GST period.
- [ ] M23: run `acctd ai-eval --invoices` with a real key once M23 is built (a few cents), choose the
      invoice reader by ADR 017, 11 (no false passes; 90% read right), and record the result in ADR 017.
      Record OCR's share, its unclear fields, and its time and memory per page too, and set the confidence
      floor from them (ADR 017, 13). Before launch, have the fixture generator make a larger set with
      photos (skew, shadow, blur) and run it again.
- [ ] M23: if the bake-off shows OCR doesn't fit beside `acctd` in 512 MB, decide whether to move
      production (and staging) to a 1 GB machine, and check the price on Fly.

## Hand checks a person has to sign off
- [ ] M10's worked example, "Worked example: the synthetic sole trader" in `docs/domain.md`. Put your name
      on its "Hand-checked by" line. M10 isn't done until this is.
- [ ] M11's worked example, "Worked example: Save tax on the synthetic sole trader" in `docs/domain.md`,
      the same way.
- [ ] M15's worked example, "Worked example: the sole trader's statements" in `docs/domain.md`, the same
      way.
- [ ] Invoice maker (Settings › Tools): check it in a browser, on a desktop and a phone. Drag and resize
      blocks (a long press starts a drag on touch), upload a logo, save and load a template, and Save as PDF;
      the PDF should match the page, with no editing marks. Also confirm it looks right in dark mode, and
      that signing in on a second device shows the same invoice and templates (they're saved to the account).
- [ ] M15: check the Reconcile tab in a browser on the synthetic sole trader (two accounts agree, Rimu
      can't be checked, and the gap journal is listed).
- [ ] M15: read the sole-trader starter paragraphs in `fixtures/practice/paragraphs.json` (the filled-in
      text is in `crates/core/src/snapshots/acct_core__notes__tests__the_starter_set_fills_in.snap`).
      "Changes in accounting policies" and "Owner's equity" were drafted without being shown to you first.
- [ ] M15: check the notes screens in a browser after `make db-reset`: Tui Street Joinery's FY2026 Notes
      tab (add, reorder, edit, drop), its Statements tab showing the notes, and Practice settings ›
      Paragraph library (revise a paragraph, preview and push it, remove one).
- [ ] M15: open the statements PDF (Statements tab › Download PDF, or `/api/years/{id}/report.pdf`) for the
      fixture company's FY2026 and the sole trader, draft and finalised. Check each statement, the asset
      schedule and the notes by eye: amounts line up, brackets and dashes, "(continued)" and the column
      headings on a run-on page, "Page n of m", and "Draft" on every page of a draft only.
- [ ] M0: build a fresh Codespace from `.devcontainer` and run `make setup && make check`.
- [ ] M3: the manual browser walkthrough, from an empty client to previewed statements with comparatives.
- [ ] M4: review the depreciation snapshots, and check the Assets tab in a browser.
- [ ] M10: check the owner screen in a browser (upload, tax figure, gaps).
- [ ] M11: check Save tax in a browser, including the AI consent screen.
- [ ] M13: open the app in two browsers as two people (an owner and their accountant, say) on the same
      business. Check each sees the other under "Here now", and the other's changes in the panel within a
      few seconds. Click the tax figure and a TB line to see their changes, and try the filters. Check the
      wording of the descriptions reads well to an owner.
- [ ] M16: in a Xero demo company (Xero's data, so don't commit it), export the chart of accounts, a Trial
      Balance, Account Transactions for the year and contacts. Run each through `acct_import::xero::parse` and
      compare with "Importing from Xero and MYOB" in `docs/domain.md`. Also open the four Xero Central
      articles cited there (they need a browser). Any layout difference becomes a synthetic test.
- [ ] M16: check the MYOB parsers against real exports. Use MYOB's sample company or a trial file, not
      client data (hard rule 1), and don't commit the files. Run each through `acct_import::myob::parse`
      and compare with "Importing from Xero and MYOB" in `docs/domain.md`. Any layout difference becomes
      a synthetic test in `fixtures/myob/`.
      - AccountRight: File › Export Data › Accounts and Cards (customer and supplier), and the Trial
        Balance and General Ledger [Detail] reports exported as CSV.
      - MYOB Business: the chart of accounts export, and the Trial Balance, General Ledger detail and
        Contacts reports exported to Excel and saved as CSV.
      - Most important: how the GL detail report signs balances. The parser assumes a balance is
        positive on the account's normal side (a credit, for liabilities, equity and income); MYOB
        doesn't document it. Then the MYOB Business contacts report's column names, which are a guess.
- [ ] M16: decide whether MYOB Business's report exports should be read straight from Excel (.xlsx).
      Today the user has to save them as CSV first, and reading .xlsx needs a new dependency.

## For the tax specialist, before M14 files anything
The items marked **check** in `docs/domain.md`; its "Open" section has the detail.
- [ ] The $60,000 GST registration threshold behind the "you may have to register" notice.
- [ ] The GST return's box layout, and rounding boxes 8 and 12 half away from zero to cents.
- [ ] Rounding income tax once, to cents.
- [ ] The 2027 rate table and the 2027 student loan threshold.
- [ ] The taxable supply information tiers ($200 and $1,000).
- [ ] The $5,000 residual income tax threshold for provisional tax.
- [ ] The GST code for ACC levies, and the $1,000 low-value threshold behind "small tools and equipment".
- [ ] The half-claim rule for entertainment.
- [ ] Whether an IR3 filed through the gateway needs an IR10 (from M14's build pack).
- [ ] GST over $200 without the records yet: that the expense stays GST-exclusive (section DB 2), how
      late the claim can be made and in which box, and that GST the owner will never get the records for
      is deductible.
- [ ] The independent earner tax credit: the text of ss LC 14 and LC 15 (legislation.govt.nz refused our
      fetch).

## Decisions and information only you can give
- [ ] Gain or loss on disposal: whether it gets its own statement line(s), and on which side
      (`docs/domain.md`, Open).
- [ ] Bank CSV layouts: export a statement from ANZ, ASB, BNZ, Westpac and Kiwibank, so the layouts can be
      copied into synthetic samples. Note whether each bank offers OFX. Real exports never go in the repo
      (hard rule 1); describe the columns only.
- [ ] Which entity type comes after sole traders: companies, partnerships or trusts (`PLAN.md`, Open
      questions).
- [ ] Whether to ship starter sets for trusts or partnerships too (only company and sole trader exist,
      2026-10-26). Each needs its own chart, template and mapping wording, and the presentation answers
      recorded in `docs/domain.md` first.
- [ ] M18 keeps each uploaded statement file as evidence. Decide how long it's kept, and confirm that
      deleting a business deletes its files too (`PLAN.md`, M18 Agent 2; record it in `docs/security.md`).
      (Decided 2026-11-03: a full card number in a card file is masked to its last four digits in the
      copy kept.)
- [ ] M18 suspect thresholds: is 3 days right for "same amount, nearby date" duplicates, and for date
      cut-offs, with the NZ banks' posting delays?
- [ ] M18 gap journals: when no statement covers some days, should the Bank vs books card say "Agrees"
      with a note about the estimated entry, or "Out by" until the missing statement is uploaded?
      Agent 8 asks this before building (`M18-PROMPTS.md`, Agent 8, task 2); record it in `docs/domain.md`.

## M12 security (`docs/security.md`): before real data goes in
- [ ] Offshore storage: production and staging run in Fly.io's Sydney region (`fly.toml`), and backups go
      to a Tigris bucket, so owners' records are stored outside New Zealand. That needs IRD approval or a
      provider on IRD's approved list ([third-party providers approved to store taxpayer electronic
      records offshore](https://www.taxtechnical.ird.govt.nz/general-articles/third-party-providers-approved-to-store-taxpayer-electronic-records-offshore)).
      Check whether Fly.io and Tigris are on it; if not, apply to IRD, or choose a host that is. Record the
      outcome in ADR 008 and `docs/security.md` ("Where the data lives").
      Found 2026-10-26: the list approves software providers, not hosts. Xero and MYOB are on it; AWS
      and Microsoft aren't. So we'd apply ourselves under s 22(8)(a) of the Tax Administration Act.
      Fly.io won't be on it.
- [ ] Decide: stay on Fly.io (Sydney) and apply for that approval, or move to a New Zealand host (AWS's
      Auckland region, open since 1 Sep 2025, or Catalyst Cloud), which needs no approval. Moving is
      cheapest before launch. Either way, a host change is a material change under IR1269 5.2, and needs
      an ADR amending 008.

## M12 tenancy (Agent 3): decisions and checks
- [ ] Make the `austin` overseer on the hosted server, once it runs a build with M12's roles:
      `fly ssh console -a <app>`, then `acctd init` (if the database is new) and `acctd add-overseer`.
- [ ] Check sign-up and invites in a browser: sign up as an owner, make an invite link, open it as staff
      in another browser and accept, then confirm a second owner sees neither business.
- [ ] Decide where the "Sign up" link goes on the public home page (the page is at `/signup`).
- [ ] The overseer's "toggle between all views" in the web app isn't built yet; today an overseer sees
      the practice screens plus every business.

## M20 guests (ADR 014): before the home page takes real files
- [x] Decide ADR 014's three open points: a guest who signs in to an existing account instead (4), the
      claim as the first step of Submit (5), and redacting an expired guest's `command_log` rows (6).
      Then mark the ADR accepted for those points, before wave 2 of `M20-PROMPTS.md` starts. Done: 4 B,
      5 A, 6 A; the ADR is accepted (M20 done, 2026-11-07).
- [ ] Privacy policy: add a section on trials. What a trial collects (the statement file and what's
      worked out from it), why (to show the visitor their tax), that nobody looks at it and nothing is
      sent to the AI provider or anyone else, where it's processed and stored, that statements name other
      people and those names are used only to sort the lines, how long it's kept (7 days from last use,
      an example 24 hours, then up to 14 days in backups), "Delete it now", and that saving your work
      keeps everything under the account's terms. The home page's line links to this section.
- [ ] Have a privacy lawyer check ADR 014, 7: that the one line beside the drop zone, plus that section,
      is enough notice under IPP 3 for a visitor with no account, and that no terms need accepting
      before a trial upload (acceptance is recorded when they claim the account).
- [ ] Tell IRD's relationship manager about trials (never filed, no gateway calls, deleted after 7 days)
      and confirm IR1269 asks nothing more of them. Describe them in the OSF answers. Include trial data
      in the offshore storage application if production stays in Sydney.
- [ ] Check the home page's wording about IRD ("File tax", "From bank statement to IRD") against IRD's
      rules for providers on naming IRD: no logo, and nothing that suggests IRD endorses us.
- [ ] Agree the privacy line's place name with the hosting decision above: "in Australia" on Fly.io
      Sydney, "in New Zealand" if production moves.
- [ ] Tell anyone testing on staging not to drop a real statement there: examples or made-up files only
      (hard rule 1). Staging shows a warning in place of the privacy line (`ACCT_GUEST_FILES=warn`).
- [ ] Check the abuse limits (ADR 014, 8) against the production volume (1 GB, ADR 008) once trials are
      live, and raise the volume and the caps together if they start refusing people.

## M21 (ADR 015): the accountant view, the peaks and practice requests
- [x] Decide ADR 015's three open points: account codes in the accountant view's general ledger (1.4),
      what replaces the "last 48 hours" banner (3.5), and whether accepting a practice request makes the
      user (7). Record 1.4 in `docs/domain.md`. Then mark the ADR accepted for those points, before wave 2
      of `M21-PROMPTS.md` starts. Done 2026-11-07: A for all three; the ADR is accepted.
- [ ] Privacy policy, practice requests: what's kept (name, email, practice name, rough client count,
      phone if given), why (to get in touch about a practice account), that only our team sees it, and
      that it's deleted 90 days after it's sent or sooner on request (ADR 015, 7).
- [ ] Privacy policy, trials: add that when someone saves their work we note which button led them to,
      and count those notes by week to improve the site, with no third-party analytics (ADR 015, 4).
- [ ] Decide who answers practice requests and how soon, and write the reply. Check Settings → Admin for
      new requests at least weekly until something tells us when one arrives.
- [ ] Until practice tenancy exists, don't make a second firm's people practice users on a server that
      holds another firm's clients: every practice user sees every client without an owner, and a
      practice admin controls the shared charts, templates and users (ADR 015, 7). Offer them the only
      practice on a server, a server of their own, or a place on the wait list.
- [ ] Delete a practice request sooner when the person asks, or when it's spam.

## Pricing page (changed 2026-11-09, ahead of M24)
- [ ] Decide the real prices; the page still says they're samples.
- [ ] Decide the Free plan's invoice upload number ("Up to 100,000" beside Owner's "Unlimited").
- [ ] Decide whether to keep the FAQ's "They'll only stay this low": it's a promise about future prices.