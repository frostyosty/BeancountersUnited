# 009: AI category suggestions

Status: accepted (2026-10-23).
- The layered, provider-agnostic design.
- Development starts on Claude Haiku 5.5, and the bake-off below chooses the production model.
- The consent wording is accepted as drafted. [N] is filled in once Anthropic's retention period is
  confirmed.
- IRD must confirm in writing before real owners use it.
ADR 008 is reserved for M12's hosting decision.

## Context
Save tax (M11) asks the owner to categorise every bank line. Most lines are routine, such as a fuel
station, a phone company or a supermarket, and a language model can pre-fill a likely category so the
owner only has to accept it. ADR 007 allows the server to call an AI provider, on these conditions:
- each integration lives in its own crate behind a trait, so tests run without a network;
- core computes every amount;
- whatever comes back is input to a command, validated like anything from the UI and recorded in
  `command_log`.

This ADR settles the provider, what leaves our server, consent, retention, IRD's position, the crate
boundary, and how suggestions are attributed.

An MCP server, where an outside AI agent recodes the ledger through our commands, was considered as the
main route for AI and rejected (2026-10-23).
- AI help is built into the product: the layered suggestions below, which the owner accepts in Save tax.
- Doing the lookups on our server before one model call is cheaper and faster than tool calls, and works
  the same with any provider.
- It also keeps every change in front of a person to accept.

## Decision

### Provider-agnostic, in layers
Switching providers is a configuration change, not a code change. Most suggestions shouldn't need a
model at all. Each line goes down these layers and stops at the first one that answers:

1. **The business's rules** (PLAN.md M11), for example "COUNTDOWN is personal". These are deterministic
   and free, and nothing leaves the server.
2. **The business's own history.** We look for an earlier line in the same business with the same
   normalised description and direction, and the same coding every time it was coded. If there is one,
   we suggest that coding. This is deterministic and free, and nothing leaves the server.
3. **The practice's merchant list.** A practice-maintained table maps description patterns to a category,
   for example "Z ENERGY → Vehicle costs". It is our own content, built from synthetic or consented data
   only. Deterministic and free, and nothing leaves the server.
4. **A language model**, for whatever is left, through the `Suggester` trait.

**Making a small model good enough.** The server does the retrieval before the call, rather than giving
the model tools:
- It puts the business's category list, the activity phrase, and up to 5 already-coded lines with similar
  descriptions (redacted the same way) into the prompt as examples.
- Tool calling, such as letting the model look up history itself, would cost extra round trips and differs
  more between providers. Doing the retrieval ourselves gives most of the same benefit in a single
  request, which every provider supports.
- The model must answer in a fixed JSON shape: reference, category code, GST code, and confidence
  (low, medium or high). Low-confidence answers don't pre-fill.

**Adapters.** `crates/ai` has two implementations of the trait, and configuration chooses one, along with
the model name, base URL and key:
- `openai_compatible`: the Chat Completions shape with a JSON-schema response format. OpenAI, Google's
  Gemini, Mistral, OpenRouter, Anthropic's compatibility endpoint and a self-hosted Ollama all accept it.
  This one adapter covers most providers.
- `anthropic`: Anthropic's native Messages API. It exists for explicit prompt caching and structured
  outputs, which the compatibility layer may not expose fully.

**Is anything lost by staying agnostic?** Very little for this task.
- It only needs a system prompt, a short batch of lines, and a structured answer, and every major
  provider offers all three.
- What differs is cost-saving features: prompt caching, batch discounts and data-residency options. The
  native adapter is where we'd use those. They change the cost, not the suggestions.
- We don't use provider-only features such as their tool runners, file stores or agent frameworks.

**Choosing the model: a bake-off.** M11 builds a synthetic, labelled set of about 300 NZ-style bank
descriptions with their correct categories (`fixtures/ai/labelled-lines.json`). An `acctd ai-eval`
command runs any configured provider over that set, and reports accuracy, the share of lines it declined
to pre-fill, and the cost. We choose the cheapest model that is at least 90% accurate on high-confidence
answers. The candidates:

| Option | Price (USD per million tokens, in / out) | Rough cost per 1,000 lines | Data leaves NZ | Notes |
|---|---|---|---|---|
| Claude Haiku 5.5 | $0.10 / $0.50 | about $0.02 | Yes | Cheapest price we've verified. Native adapter. |
| Claude Sonnet 5.5 | $2 / $10 | about $0.31 | Yes | For when Haiku isn't accurate enough. |
| OpenAI's small "mini" model | not checked | likely similar to Haiku | Yes | Through the compatible adapter. |
| Google Gemini Flash family | not checked | likely similar to Haiku | Yes | Through the compatible adapter. |
| An open-weights model, self-hosted (e.g. a 7B to 8B model via Ollama) | Hosting cost only | Fixed monthly cost | **No** | Removes the offshore and processor questions. It needs a machine with enough memory, may need a GPU host, and is likely less accurate. |
| No model (layers 1 to 3 only) | $0 | $0 | **No** | Good on repeat merchants, weak on first-time lines. |

- **Recommendation:**
  - Build layers 1 to 3 and both adapters.
  - Start development on Claude Haiku 5.5, because it is cheap and its pricing is verified.
  - Let the bake-off settle the production model before launch.
  - Disclosure: this ADR was drafted by Claude, an Anthropic model, so check that recommendation with the
    bake-off.
- **Cost per 1,000 bank lines** (the Claude rows above), at Anthropic's list prices on 2026-10-23
  ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)), in USD:
  - Assumptions:
    - lines are sent in requests of 50;
    - each request reuses a cached prefix of about 2,000 tokens (the instructions and the category list);
    - each line costs about 30 input tokens and 25 output tokens.
    - That is about 30,000 input tokens, 25,000 output tokens and 40,000 cache reads per 1,000 lines.
  - Haiku 5.5 ($0.10 / $0.50 per million input / output tokens, $0.01 per million cache reads): about
    **$0.02**. Allow for the newer tokenizer's roughly 30% more tokens and it stays under $0.05.
  - Sonnet 5.5 ($2 / $10, $0.10 cache reads): about **$0.31**.
  - The Batch API halves both, but it is asynchronous (minutes to hours), so it suits a background pass
    after upload, not an owner waiting on a card.
- **Region.** Anthropic offers no New Zealand or Australian inference region. The `inference_geo` option
  pins inference to the US at 1.1× the price; the default is global routing. We use the default, and the
  consent text says the data is processed overseas.

### What leaves the server
Only what is needed to choose a category. The request is built by one pure function in `crates/ai`
(`redact::request`). Its output type has private fields, so nothing else can build a request.

| Field | Sent | Notes |
|---|---|---|
| Line reference | Yes | An index within this request (1, 2, 3, …), never a database id |
| Direction | Yes | In or out |
| Amount | Yes | Rounded to whole dollars. Enough to tell a coffee from a laptop |
| Description | Redacted | See below |
| Category list | Yes | Our account names and their codes for this business's chart. It's our own content |
| Business activity | Optional | A short phrase the owner chooses, e.g. "candle maker". Never the business's name |
| Date, balance, bank, account number, statement file name | No | |
| Owner's name, business name, IRD number, address, email | No | |
| Anything IRD sent us (M14 prefill, filing data) | No | |

**Redaction of the description**, applied in this order, with a test for each rule:
1. Drop the bank's separate particulars, code and reference fields where a parser keeps them apart. These
   are where people type names and invoice numbers.
2. Replace anything shaped like an NZ bank account number (`BB-bbbb-AAAAAAA-SS`, with or without
   separators) with `[acct]`.
3. Replace IRD-number shapes (8 or 9 digits, optionally `NNN-NNN-NNN`) with `[ird]`.
4. Replace email addresses, phone numbers and URLs with `[email]`, `[phone]` and `[url]`.
5. Replace any remaining run of 6 or more digits (card numbers, references) with `#`.
6. Remove the owner's name, any other names on the account, and the business name, matched
   case-insensitively as whole words, along with their initials-and-surname forms (`Q MARSH`,
   `MARSH Q`).
7. Trim to 60 characters.

A transfer that names a private individual (for example `J SMITH`) can still get through rules 1 to 6.
The consent text says so. A later rule could drop descriptions that look like a person's name.

### Consent
- Suggestions are **off by default, per business**.
- The owner turns them on with a new command, `set_ai_suggestions { client_id, enabled, consent_version }`.
  It is logged like every other command, so the log is the consent record that IRD can ask for
  (ADR 007).
  - Until M12 adds the `owner` role, staff and the practice owner may turn it on for a client, and the
    command records that they did so on the client's behalf.
- Turning it off stops all requests at once. Suggestions already made stay as pre-fills until the owner
  answers those cards.
- Changing the consent wording, or the provider, bumps `consent_version`. Businesses that agreed to an older version are
  asked again before more requests are sent.
- **Wording (accepted 2026-10-23):**
  > **Suggest categories for me**
  > We can ask an AI service ([provider], named here and updated if it changes) to suggest a category for
  > each transaction, so you can
  > accept them in one go. It sees each transaction's description and rounded amount, and our list of
  > categories. It never sees your name, your business's name, your bank account numbers or your IRD
  > number, and we strip those out of descriptions too. A description can still name someone you paid.
  > The service runs overseas. It doesn't use your data to train its models, and deletes it within
  > [N] days. Nothing changes until you accept a suggestion. You can turn this off at any time.

### Retention
- **At the provider.**
  - Anthropic doesn't use API data for training without express permission
    ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)).
  - Its standard commercial retention period applies
    ([commercial data retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).
    Confirm the number of days before the consent wording is final.
  - Zero data retention is available per organisation through Anthropic's sales team. Apply before
    launch. ZDR doesn't cover the Batch API or prompt caching, so if we get ZDR we may have to give up
    those two discounts. The trade-off is decided then.
- **With us.**
  - We store each suggestion: the line, the coding, the model id and a confidence.
  - We don't store prompts or raw responses. Logs never contain request or response bodies.
  - A suggestion the owner never accepts is deleted when its line is coded some other way, or when the
    owner turns suggestions off.

### IRD's position
- IRD's public pages for software providers don't mention AI or third-party processors:
  - [Working with us](https://www.ird.govt.nz/digital-service-providers/working-with-us)
  - [Operational Security Framework](https://www.ird.govt.nz/digital-service-providers/operational-security-framework)
  - [Information disclosures](https://www.ird.govt.nz/digital-service-providers/working-with-us/information-disclosures)

  They require services to be used for tax and social policy purposes, information to be protected
  under the OSF (which is aligned with ISO 27001), and disclosures to be ones the Tax Administration Act
  permits.
- What we send isn't information from IRD. It's the owner's own bank data, redacted, used to prepare the
  owner's own return, which is a tax purpose. Nothing that came through the gateway is ever sent.
- Storing records offshore needs either IRD approval or an approved provider
  ([offshore storage list](https://www.taxtechnical.ird.govt.nz/general-articles/third-party-providers-approved-to-store-taxpayer-electronic-records-offshore)).
  This doesn't apply here: the provider processes a request and doesn't keep the business's records, and
  the records stay on our server.
- Under the Privacy Act 2020, section 11, a provider that only processes information on our behalf, and
  not for its own purposes, holds it as our agent. Sending it isn't a disclosure, and IPP 12 (cross-border
  disclosure) doesn't apply. We remain responsible for the provider's handling of it.
- **Before launch:** ask our IRD account manager to confirm in writing, as part of the business track's
  onboarding, and list the provider as a subprocessor in `docs/security.md` (M12) and in the OSF answers.
  This must be settled before suggestions are turned on for real owners. Development with synthetic data
  isn't affected.

### Crate boundary
- `crates/ai`:
  - a `Suggester` trait: `suggest(&self, request: SuggestRequest) -> Result<Vec<RawSuggestion>, AiError>`
  - `redact`: pure, and the only way to build a `SuggestRequest`
  - `openai_compatible` and `anthropic`: the HTTP adapters. Configuration (`AI_PROVIDER`, `AI_MODEL`,
    `AI_BASE_URL` and `AI_API_KEY`) picks one.
  - `FakeSuggester`: canned answers keyed on description words, for tests and for `acct-dev`
  - `eval`: runs a suggester over the labelled set and reports accuracy and cost. It is what `acctd ai-eval`
    runs.
- Layers 1 to 3 (rules, the business's history and the merchant list) aren't AI. They live in
  `acct_core::coding`, which is pure, and the server runs them before it calls the suggester.
- Tests never touch the network. The real client is tested against recorded responses only.
- The API key comes from the server's configuration. It is never in the repo, the database or a log.
- The server holds an `Arc<dyn Suggester>`. With no key configured it uses no suggester, and the Save tax
  screen simply shows no suggestions.

### From suggestion to command
1. After an upload, or when the owner opens Save tax, a background task takes the unsorted lines that
   layers 1 to 3 couldn't answer. Layers 1 to 3 always win over the model, and they cost nothing.
2. It calls the suggester **outside any transaction**, because the single writer connection must never
   wait on the network.
3. It validates what comes back:
   - the reference maps to a line in the request
   - the category is one we offered
   - the GST code is valid for that category
   - the line is still unsorted

   Anything else is dropped and counted in a metric.
4. It submits a `record_suggestions` command, carrying the coding, the model id and the confidence for
   each line. That command changes no figures. It stores pre-fills, so it goes through the pipeline like
   every other write (hard rule 6).
5. The Save tax card shows the pre-fill. Accepting it, or "accept all", sends the ordinary
   `code_bank_line` / `code_bank_lines` command with `via` set (below). Core computes every amount, GST
   split and saving. The model only names a category.

### Attribution: `actor` and `via`
- Every command already has an **actor**: the signed-in user who is accountable for it. That doesn't
  change. A model is never the actor.
- The command envelope gains an optional **`via`**, stored in a new nullable `command_log.via` column
  (a JSON object, in an append-only migration when this is built):
  ```json
  { "kind": "suggestion", "model": "claude-haiku-5-5", "suggestion_ids": ["…"] }
  ```
  The `suggestion` kind means the user accepted pre-fills. The UI sends it, and the server checks that
  each id is a live suggestion for that line and that the coding matches it. If the user edited the
  pre-fill before saving, the change is attributed to the user alone, with no `via`.
- M13's history reads this as "suggested by Claude Haiku 5.5, accepted by Sam".
- `via` is a tagged object, so it can take other kinds later without a schema change. No other kinds are
  planned. An MCP server for outside agents is not on the roadmap (see Context).

## Consequences
- Moving to another provider means changing configuration and running the bake-off again. Each
  provider-specific adapter is about a page of code.
- The owner gets pre-filled categories for a few US cents per 1,000 lines at most, and repeat merchants
  cost nothing. Without a key or consent,
  Save tax works the same, just without pre-fills.
- Redacted bank descriptions leave New Zealand when an owner opts in. The consent record is the command
  log.
- Before suggestions are turned on for real owners, IRD has to confirm, the provider has to appear in the
  security documentation, and ZDR is applied for.
- `command_log` gains `via`. M13's history builds on it rather than on a second record.
- The synthetic, labelled set (`fixtures/ai/labelled-lines.json`) and `acctd ai-eval` are part of M11's AI
  work. Every model choice is made against that set.
