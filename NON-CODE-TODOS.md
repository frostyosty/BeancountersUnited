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
      evidence of that consent.

## AI suggestions (ADR 009): before real owners turn them on
Development with synthetic data isn't affected.
- [ ] Ask our IRD account manager to confirm in writing that sending redacted bank lines to an AI
      provider is acceptable (ADR 009, "IRD's position"). Do this as part of the business track.
- [ ] Apply to Anthropic's sales team for zero data retention. ZDR doesn't cover the Batch API or prompt
      caching, so decide then whether to give up those discounts. If the retention period changes, update
      `RETENTION_DAYS` in `apps/web/src/pages/SaveTaxAi.tsx` and bump `CONSENT_WORDING` in
      `crates/server/src/ai.rs`.
- [ ] List Anthropic as a subprocessor in `docs/security.md` (M12) and in the OSF answers.
- [ ] Someone with accounting knowledge checks the labels in `fixtures/ai/labelled-lines.json` (category
      and GST code per line). Fix them in `tools/ai-labelled-lines/generate.py` and rebuild.
- [ ] Run the bake-off with real API keys (it costs a few cents): `AI_PROVIDER=anthropic AI_API_KEY=...
      acctd ai-eval`, then try other models with `AI_MODEL`. Choose the production model and record it in
      ADR 009.

## Hand checks a person has to sign off
- [ ] M10's worked example, "Worked example: the synthetic sole trader" in `docs/domain.md`. Put your name
      on its "Hand-checked by" line. M10 isn't done until this is.
- [ ] M11's worked example, "Worked example: Save tax on the synthetic sole trader" in `docs/domain.md`,
      the same way.
- [ ] M15's worked example, "Worked example: the sole trader's statements" in `docs/domain.md`, the same
      way.
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

## M12 security (`docs/security.md`): before real data goes in
- [ ] Offshore storage: production and staging run in Fly.io's Sydney region (`fly.toml`), and backups go
      to a Tigris bucket, so owners' records are stored outside New Zealand. That needs IRD approval or a
      provider on IRD's approved list ([third-party providers approved to store taxpayer electronic
      records offshore](https://www.taxtechnical.ird.govt.nz/general-articles/third-party-providers-approved-to-store-taxpayer-electronic-records-offshore)).
      Check whether Fly.io and Tigris are on it; if not, apply to IRD, or choose a host that is. Record the
      outcome in ADR 008 and `docs/security.md` ("Where the data lives").

## M12 tenancy (Agent 3): decisions and checks
- [ ] Make the `austin` overseer on the hosted server, once it runs a build with M12's roles:
      `fly ssh console -a <app>`, then `acctd init` (if the database is new) and `acctd add-overseer`.
- [ ] Check sign-up and invites in a browser: sign up as an owner, make an invite link, open it as staff
      in another browser and accept, then confirm a second owner sees neither business.
- [ ] Decide where the "Sign up" link goes on the public home page (the page is at `/signup`).
- [ ] The overseer's "toggle between all views" in the web app isn't built yet; today an overseer sees
      the practice screens plus every business.
