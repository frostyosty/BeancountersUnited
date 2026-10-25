# 011: Generalised AI requests, and no consent screen

Status: proposed (2026-10-26).
- Amends ADR 009's "What leaves the server" and "Consent". The rest of ADR 009 stands: the layers, the
  adapters, the bake-off, checking answers, `record_suggestions` and `via`.
- **Removing the consent screen** was decided by the owner on 2026-10-26 and is done (see "Consent").
- **The generaliser** is proposed. It must be built, and the bake-off re-run, before real owners get
  suggestions. Until then, suggestions run on synthetic data only, which hard rule 1 and ADR 009's IRD
  condition already require.

## Context
ADR 009 redacts each description by removing what it recognises: account numbers, IRD numbers, contact
details, long runs of digits, and the names we know about. That's a denylist. Anything it doesn't
recognise goes out as typed, so a transfer to `J SMITH` still names a private individual. That's why
ADR 009 has an opt-in screen that says so, and says the service runs overseas.

To choose a category, the model only needs to know what kind of transaction it is, what kind of party
is on the other side, roughly how much it was, how often it recurs, and a few generic words. It never
needs to know who anyone is. If nothing that leaves the server is about an identifiable person, the
request carries no personal information, and a consent screen for this one feature isn't needed. We
then disclose the provider the way other cloud accounting software discloses its subprocessors: in our
privacy notice and in the terms the owner accepts at sign-up.

Considered and rejected:
- **An MCP server that "decrypts" for the model.** An MCP server would let the model call back into our
  data, which is the opposite of what we want, and ADR 009 already rejected one. The model doesn't need
  to decrypt anything. It answers with a reference number and a category code, and the Save tax card
  shows the real line from our own database.
- **Encrypting descriptions.** A model can't categorise ciphertext. The only safe thing to give it in
  place of a name is a placeholder that carries no information, and that's what the generaliser does.
- **No model at all** (layers 1 to 3 only). This stays the fallback when no provider is configured.

## Decision

### Heuristics first (unchanged)
Layers 1 to 3 of ADR 009 (the business's rules, its own history and the practice merchant list) answer
every line they can. They're deterministic, cost nothing, and send nothing. Only the lines they can't
answer reach the generaliser.

### The generaliser: an allowlist, not a denylist
A pure function, `acct_core::coding::generalise`, turns each line into the features below.
`acct_ai::redact::request` is still the only way to build a request, and it sends only these features.

| Feature | Values | Worked out from |
|---|---|---|
| Reference | 1, 2, 3 … within the request | As in ADR 009. Never a database id |
| Direction | in, out | The amount's sign |
| Size | The amount to two significant figures: $47, $1,200, $35,000 | The amount |
| Transaction kind | card purchase, direct debit, automatic payment, bill payment, transfer, ATM withdrawal, bank fee, interest, unknown | The bank's transaction type where the parser keeps it (OFX `TRNTYPE`), otherwise a description prefix such as `POS`, `EFTPOS`, `DD`, `AP`, `BP`, `TFR` or `ATM` |
| Counterparty | business, person, the owner's own account, IRD, the bank, unknown | The rules below |
| Recurrence | one-off, weekly, fortnightly, monthly, yearly, and whether the amount is the same each time | The business's other lines with the same normalised description |
| Words | Vocabulary words, in their original order. Every other word becomes a placeholder | The description |

**Counterparty rules.** The first match wins:
1. **IRD:** the description names Inland Revenue.
2. **The bank:** fee and interest lines.
3. **Own account:** a transfer to or from one of the business's own bank accounts (core's transfer
   matching).
4. **Business:** a brand in the vocabulary, a company marker (`LTD`, `LIMITED`), or a card purchase.
5. **Person:** a name shape, such as initials and a surname (`J SMITH`, `SMITH J`), or the payee on an
   automatic payment or transfer that has no business marker.
6. **Otherwise:** unknown.

**The vocabulary** is our own content (hard rule 3), kept in `crates/core/src/coding/`:
- Generic words that say what was bought or paid: `RENT`, `FUEL`, `COFFEE`, `HARDWARE`, `INSURANCE`,
  `POWER`, `PHONE`, `SUBSCRIPTION`, `PARKING`, and so on.
- Brands of businesses large enough that their name can't point to a person: the entries in the
  practice merchant lists (layer 3), plus a list we maintain of national chains and common online
  services (`COUNTDOWN`, `BUNNINGS`, `Z ENERGY`, `SPARK`, `NETFLIX.COM`). A company isn't an
  individual, so its name isn't personal information. A business named after a person
  (`J SMITH PLUMBING`) isn't on the list, so its name becomes a placeholder.
- ADR 009's redaction rules 2 to 6 still run first, as a second line of defence. A private name is
  removed even when it's also a vocabulary word, such as an owner whose surname is `Baker`.

**Placeholders** show the counterparty kind and a number within the request: `[PERSON_1]`,
`[BUSINESS_2]`, `[WORD_3]`. The same word gets the same placeholder on every line of a request, so the
model can still see that two lines share a payee. Numbering starts again with every request. The map
from placeholder to word lives in memory for that request only, and is never stored or logged. Digits
never go out: any number becomes `#`.

For example, `AP J SMITH RENT 0412` becomes:

```
3 · out · $450 · automatic payment · person · monthly, same amount · [PERSON_1] RENT #
```

**Examples and the activity phrase.**
- The already-coded examples (up to 5, ADR 009) go through the same generaliser.
- The category list is our own content and is unchanged.
- The owner's activity phrase goes through the vocabulary too, so `candle maker` stays and a name
  doesn't. A later change could have the owner pick it from IRD's business industry classification (BIC)
  list instead of typing it.

ADR 009's list of what never leaves (dates, balances, bank, account numbers, statement file names,
names, IRD numbers, addresses, emails, and anything IRD sent us) is unchanged.

### Putting names back
- The model answers with a reference, a category code, a GST code and a confidence, as in ADR 009. It
  never sees or returns the real text. The server maps the reference to the line, and the card shows
  the line from our database.
- If a later feature lets the model write text the owner reads, such as the reason for a suggestion,
  the server swaps each placeholder back for its words before showing it. The text is still checked
  like any other input.

### Accuracy and the bake-off
Generalising hides the name of a first-time merchant that isn't in the vocabulary, so some accuracy is
lost. `acctd ai-eval` runs the labelled set both ways (ADR 009's redaction, and generalised), and
reports accuracy and the share declined for each. The generaliser ships if high-confidence accuracy
stays at 90% or more (ADR 009's bar). If it doesn't, we grow the vocabulary first, because that's the
cheapest fix, and record the results here.

A property test in `crates/ai/src/leak_tests.rs` builds descriptions from random words and synthetic
names, and checks that every word in every request is a vocabulary word, a placeholder or a feature
value.

### Consent
- **No consent screen.** AI suggestions are on by default wherever the server has a provider
  configured. The owner (or staff for them) can turn them off in Save tax. As in ADR 009, turning them
  off stops all requests and deletes the suggestions still waiting.
- `set_ai_suggestions` no longer takes `consent_version`. It turns suggestions on or off and sets the
  activity phrase and private names. Older log entries that carry `consent_version` still read; the
  field is ignored.
- A business with no `ai_settings` row has suggestions on. The `ai_settings.consent_version` column
  stays, because migrations are append-only, and is no longer written or read.
- **Disclosure** moves to where cloud software usually puts it. The privacy notice names the provider as
  a subprocessor, says what's sent (generalised features, nothing that identifies anyone) and where
  it's processed. The owner accepts the terms and privacy notice at sign-up, and that acceptance is
  recorded as a command when the customer terms are built (`NON-CODE-TODOS.md`). That record is the
  evidence of consent that IR1269 clauses 4(h) and 4(i) ask for, if IRD treats this as a disclosure at
  all.
- **Why we think this holds.** This is our reading, not legal advice, and it's checked before launch:
  - The Privacy Act 2020 covers personal information: information about an identifiable individual. A
    generalised request names no-one. Its placeholders start again with every request, so the provider
    can't link anything in it back to a person.
  - ADR 009's view still applies on top. The provider processes only on our behalf (section 11), so
    sending isn't a disclosure, and IPP 12 doesn't apply.
  - IR1269 4(h) and 4(i) concern taxpayer information. We send nothing from IRD, and nothing that
    identifies the taxpayer.
- **The gap until the generaliser ships.** The consent screen was removed on 2026-10-26, before the
  generaliser exists, so for now descriptions still go out with ADR 009's redaction only. That's
  acceptable only because no real owner can use suggestions yet. Real owners don't get suggestions until
  the generaliser ships.

### IRD
- Still ask our IRD account manager to confirm in writing (ADR 009). The question is simpler now:
  nothing from IRD, and nothing that identifies anyone, leaves the server.
- Changing what leaves the server is a material change under IR1269 clause 5.2, so tell IRD before it
  reaches real owners.

### Retention
Unchanged from ADR 009: Anthropic keeps API data for 30 days and doesn't train on it. Zero data
retention is still worth applying for, but it matters less when nothing personal is sent.

### Where it lives
- `acct_core::coding::generalise`: features, counterparty rules, recurrence and the vocabulary. Pure,
  with a test for each rule.
- `acct_ai::redact::request`: takes generalised lines. `SentLine` gains the feature fields, and its
  description becomes `words`.
- `acct_ai::prompt`: explains the features and placeholders to the model.
- `crates/server/src/ai.rs`: gives the generaliser what it needs, including the business's other lines
  (for recurrence) and its own bank accounts.
- `fixtures/ai/labelled-lines.json`: gains the bank transaction types, so the bake-off can test the
  features.

## Consequences
- The model sees what kind of transaction a line is, roughly how much it was, how often it recurs, and
  generic words. It never sees a name, account, date or anything else that identifies the owner or the
  people they pay.
- There's no consent screen. Suggestions are on by default and can be turned off. Disclosure lives in
  the privacy notice and the sign-up terms.
- Some accuracy is lost on unfamiliar merchants. The bake-off measures it, and growing the vocabulary
  recovers it.
- The vocabulary becomes something we maintain, like the merchant list.
- Hosting isn't affected. Fly.io holds the real records, and offshore storage (ADR 008) is a separate
  question.
