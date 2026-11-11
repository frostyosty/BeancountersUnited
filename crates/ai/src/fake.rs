//! A suggester with canned answers keyed on description words, for tests and `acct-dev`. It also
//! keeps every request it was given, so tests can check exactly what would have left the server.

use std::sync::Mutex;

use acct_core::GstCode;

use crate::{
    AiError, Call, Confidence, ExplainFuture, ExplainRequest, RawSuggestion, SuggestFuture,
    SuggestRequest, Suggester, Usage,
};

/// The tokens each successful call of a [`FakeSuggester`] reports, unless
/// [`FakeSuggester::with_usage`] says otherwise. A failing one reports none, as a network error
/// would.
pub const FAKE_CALL_USAGE: Usage = Usage {
    requests: 1,
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
};

/// "A line whose description contains `contains` is `category`." `category` is a category key,
/// or else a word in a category's name, such as `freight`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeAnswer {
    pub contains: String,
    pub category: String,
    pub gst: GstCode,
    pub confidence: Confidence,
}

impl FakeAnswer {
    pub fn new(contains: &str, category: &str, gst: GstCode, confidence: Confidence) -> Self {
        FakeAnswer {
            contains: contains.to_uppercase(),
            category: category.to_owned(),
            gst,
            confidence,
        }
    }
}

pub struct FakeSuggester {
    model: String,
    answers: Vec<FakeAnswer>,
    fail: bool,
    usage: Usage,
    /// Write explanations the way a real model would, instead of echoing the facts.
    demo_text: bool,
    seen: Mutex<Vec<SuggestRequest>>,
    explained: Mutex<Vec<ExplainRequest>>,
}

impl FakeSuggester {
    pub fn new(model: &str, answers: Vec<FakeAnswer>) -> Self {
        FakeSuggester {
            model: model.to_owned(),
            answers,
            fail: false,
            usage: FAKE_CALL_USAGE,
            demo_text: false,
            seen: Mutex::new(Vec::new()),
            explained: Mutex::new(Vec::new()),
        }
    }

    /// The tokens each successful call reports, so tests can check what an ask cost.
    #[must_use]
    pub fn with_usage(mut self, usage: Usage) -> Self {
        self.usage = usage;
        self
    }

    /// One that always fails, as an unreachable provider would.
    pub fn failing(model: &str) -> Self {
        FakeSuggester {
            fail: true,
            ..FakeSuggester::new(model, Vec::new())
        }
    }

    /// Answers for the kinds of merchant in the synthetic fixtures, by category name.
    pub fn with_defaults(model: &str) -> Self {
        use Confidence::{High, Low, Medium};
        use GstCode::{Exempt, None, Standard};
        let a = FakeAnswer::new;
        FakeSuggester::new(
            model,
            vec![
                a("POWER", "power", Standard, High),
                a("COURIER", "freight", Standard, High),
                a("MOBILE", "phone", Standard, High),
                a("INSURANCE", "insurance", Standard, High),
                a("HOSTING", "software", Standard, High),
                a("STATIONER", "stationery", Standard, High),
                a("GAS & GO", "vehicle", Standard, Medium),
                a("SUPPLIES", "purchases", Standard, Medium),
                a("HARDWARE", "small tools", Standard, Medium),
                a("STALL FEE", "advertising", Standard, Low),
                a("GROCER", "personal", None, High),
                a("CAFE", "personal", None, Medium),
                a("ATM", "personal", None, Medium),
                a("INTEREST", "interest", Exempt, High),
                a("GIFTS", "sales", Standard, High),
                a("BOUTIQUE", "sales", Standard, High),
                a("PAYOUT", "sales", Standard, Medium),
            ],
        )
    }

    /// For `AI_PROVIDER=fake` on a dev machine: the default answers plus the merchants in
    /// `fixtures/landing/`, and explanations written like a real model's (`demo_explanation`).
    pub fn with_demo(model: &str) -> Self {
        use Confidence::{High, Low, Medium};
        use GstCode::{Exempt, None, Standard};
        let mut s = FakeSuggester::with_defaults(model);
        let a = FakeAnswer::new;
        s.answers.extend([
            // Example 1: a coffee cart.
            a("MERCH 4471", "sales", Standard, High),
            a("TAPPA", "sales", Standard, High),
            a("CATERING DEP", "sales", Standard, High),
            a("RANGI ROASTERS", "purchases", Standard, High),
            a("HILLTOP DAIRY", "purchases", Standard, High),
            a("CUP AND LID", "purchases", Standard, High),
            a("TUSSOCK FUEL", "vehicle", Standard, High),
            a("HARBOUR MARKETS", "advertising", Standard, Low),
            a("BREWLINE", "small tools", Standard, Low),
            a("MONTHLY ACCOUNT FEE", "bank fees", Standard, High),
            a("INTEREST CREDIT", "interest", Exempt, High),
            // Example 2: a freelance designer, not GST registered.
            a("WHENUA ARCHITECTS", "sales", None, High),
            a("KŌRERO MEDIA", "sales", None, High),
            a("HĀPAI TRUST", "sales", None, High),
            a("FROM PARTNER", "money the owner put in", None, Medium),
            a("R & S HOLDINGS", "personal", None, Medium),
            a("KAPAI CAF", "personal", None, Medium),
            a("FIBRESTREAM", "phone", None, High),
            a("FONTWORKS", "software", None, High),
            a("PIXELFORGE", "software", None, High),
            a("CO-WORK HUB", "rent", None, Medium),
            a("PRINTHAUS", "stationery", None, Medium),
            a("WHARE BOOKS", "general", None, Low),
            a("NOHO TECH", "small tools", None, Low),
            a("ACCOUNT FEE", "bank fees", None, High),
            // Example 3: an electrician.
            a("MOANA PROPERTY", "sales", Standard, High),
            a("LAKESIDE MOTEL", "sales", Standard, High),
            a("PURIRI BUILDERS", "sales", Standard, High),
            a("B NGATA", "sales", Standard, High),
            a("T WIREMU", "sales", Standard, High),
            a("VOLTEDGE", "purchases", Standard, High),
            a("SOUTHFUEL", "vehicle", Standard, High),
            a("SPARKREG", "general", Standard, Medium),
            a("LEVY 2025", "acc levies", None, High),
            a("TRADESURE", "insurance", None, High),
            a("CHEQUE", "general", Standard, Low),
            a("ROTORUA MOTOR", "vehicle", Standard, Low),
        ]);
        s.demo_text = true;
        s
    }

    /// Every request it has been given, oldest first.
    pub fn seen(&self) -> Vec<SuggestRequest> {
        self.seen.lock().expect("not poisoned").clone()
    }

    /// Every explanation request it has been given, oldest first.
    pub fn explained(&self) -> Vec<ExplainRequest> {
        self.explained.lock().expect("not poisoned").clone()
    }

    fn answer(&self, request: &SuggestRequest) -> Vec<RawSuggestion> {
        request
            .lines()
            .iter()
            .filter_map(|line| {
                let description = line.description().to_uppercase();
                let answer = self
                    .answers
                    .iter()
                    .find(|a| description.contains(&a.contains))?;
                let wanted = answer.category.to_lowercase();
                let category = request
                    .categories()
                    .iter()
                    .filter(|c| c.direction == line.direction())
                    .find(|c| {
                        c.key == answer.category || c.name.to_lowercase().contains(&wanted)
                    })?;
                Some(RawSuggestion {
                    reference: line.reference(),
                    category: category.key.clone(),
                    gst: answer.gst,
                    confidence: answer.confidence,
                })
            })
            .collect()
    }
}

impl Suggester for FakeSuggester {
    fn provider(&self) -> &str {
        "a test service"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn suggest(&self, request: SuggestRequest) -> SuggestFuture<'_> {
        let call = if self.fail {
            Call::failed(AiError::Network("the fake is set to fail".to_owned()))
        } else {
            Call::new(Ok(self.answer(&request)), self.usage)
        };
        self.seen.lock().expect("not poisoned").push(request);
        Box::pin(async move { call })
    }

    fn explain(&self, request: ExplainRequest) -> ExplainFuture<'_> {
        let call = if self.fail {
            Call::failed(AiError::Network("the fake is set to fail".to_owned()))
        } else {
            let text = if self.demo_text {
                demo_explanation(request.facts())
            } else {
                format!(
                    "This is a test explanation. It was given: {}",
                    request.facts().replace('\n', " / ")
                )
            };
            Call::new(Ok(text), self.usage)
        };
        self.explained.lock().expect("not poisoned").push(request);
        Box::pin(async move { call })
    }
}

/// What a small model would plausibly say about one Save tax card, written from the facts it was
/// given and nothing else. Only for `AI_PROVIDER=fake`, so the screen can be tried without a key.
fn demo_explanation(facts: &str) -> String {
    let field = |name: &str| {
        facts
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    let item = field("Item: ");
    let business = field("The business: ");
    let saving = field("Answering could lower the tax by ");
    let line = field("Bank line: ");
    // `money out, $248, "RANGI ROASTERS LTD EFTPOS 01OCT WELLINGTON"`
    let (direction, rest) = line.split_once(", ").unwrap_or(("", ""));
    let (dollars, description) = rest.split_once(", ").unwrap_or(("", ""));
    let description = description.trim_matches('"');
    let what = if description.is_empty() {
        "This payment".to_owned()
    } else {
        format!("The {dollars} line \"{description}\"")
    };
    let money_in = direction == "money in";
    let upper = description.to_uppercase();
    let saving_note = if saving.is_empty() {
        String::new()
    } else {
        format!(
            " Getting this right could lower your tax by {}.",
            saving.trim_end_matches('.')
        )
    };
    let for_business = if business.is_empty() {
        String::new()
    } else {
        format!(" For a {business}, it helps to keep the receipt or invoice for this.")
    };

    let has = |words: &[&str]| words.iter().any(|w| upper.contains(w));

    if item.starts_with("Was this business the owner's only income") {
        "Until you answer, we assume you earn enough elsewhere to pay the top 39% rate on every dollar of profit. If this business is your only income, the first part of your profit is taxed at much lower rates, so your answer can cut the figure a lot. Think about whether you had wages, a benefit or other self-employment during the year. If you did, answer no and the next questions will ask about it.".to_owned()
    } else if item.starts_with("Did the owner have a student loan") {
        "Right now 12% of your profit is set aside for student loan repayments, in case you have one. If you don't have a loan, answering no takes that amount off the tax to pay. If you do, the real repayment depends on your total income for the year, which the other questions help pin down. Your latest student loan balance letter will settle it.".to_owned()
    } else if item.starts_with("What other income") {
        "Wages, benefits and interest from elsewhere are added to your business profit, and together they decide which tax rates apply. Tax already taken off those amounts, such as PAYE on wages, is credited against what you owe. Check your payslips or myIR for the totals. If you had none, say so and the figure may drop.".to_owned()
    } else if item.starts_with("How many months") {
        "The independent earner tax credit is up to $10 a week, so up to $520 for a full year. It isn't available for months when you got Working for Families, NZ Super, a main benefit or a student allowance. Count only the months with none of those. If you aren't sure, check the credit's income limits first.".to_owned()
    } else if item.starts_with("Is the business registered for GST") {
        "We only guessed GST registration from your statements. If you are registered, GST on your sales is owed to IRD and GST on business costs can be claimed back. If you aren't, none of that applies and the figures change. A letter from IRD showing your GST number, or myIR, will tell you for sure.".to_owned()
    } else if item.starts_with("Did this money move between") {
        format!(
            "{what} looks like money moving between accounts that are both yours, such as into savings. That isn't income or spending, so it shouldn't be taxed or claimed. Check that the other account really is yours, and upload its statement so both sides show. If it went to someone else, it needs sorting as spending instead.{saving_note}"
        )
    } else if item.starts_with("Is this a GST refund") {
        format!(
            "{what} looks like a GST refund from Inland Revenue. A GST refund gives back money you paid out, so it is not income and shouldn't be taxed. Check your GST return for the matching period to confirm the amount.{saving_note}"
        )
    } else if item.starts_with("Is this a payment to IRD") {
        let kind = if has(&["GST"]) {
            "the memo mentions GST, so it looks like a GST payment. GST paid isn't a business cost, but it doesn't count as tax owing again either."
        } else if has(&["INC TAX"]) {
            "the memo mentions income tax, so it looks like a payment towards your income tax. Tax already paid is credited against what you owe, which lowers the amount left to pay."
        } else {
            "the text doesn't say which tax it was for. That matters, because income tax paid is credited against your bill but GST isn't."
        };
        format!(
            "{what} is a payment to Inland Revenue, and {kind} Have your IRD statement or the payment confirmation to hand to see which tax and period it covers.{saving_note}"
        )
    } else if item.starts_with("Is this the same transaction") {
        format!(
            "{what} appears on two statements, which can happen when they overlap. If it is one real payment, it should be counted only once, or the tax will be out. Compare the dates and bank references on both statements. Two genuine payments of the same amount on the same day are possible, though.{saving_note}"
        )
    } else if item.starts_with("A bank statement is missing") {
        "Some days have no statement, and the balance rose over them. Until a statement shows what that money was, the rise is counted as income and taxed. Download the statement for those days from your bank and upload it. The real income and spending will then replace the guess.".to_owned()
    } else if item.starts_with("Does the owner have the tax invoice") {
        format!(
            "For a purchase over $200, you can only claim the GST back if you hold the supplier's tax invoice. It must show their GST number and be kept for seven years. {what} is big enough to need one. Look in your email or the supplier's account for it before you claim.{saving_note}"
        )
    } else if item.starts_with("The books and the bank") {
        "What is recorded and what the bank statement shows are different. Until they match, the tax figure could be off, because a line may be missing, doubled or the wrong amount. Compare the statement's opening and closing balances with your totals to find where they split. The size of the difference is a hint to the cause.".to_owned()
    } else if item.starts_with("What was this") {
        let guess = if money_in {
            if has(&["MERCH", "TAPPA", "INV", "CATERING"]) {
                "It looks like a customer paying you, which is business income and should stay taxed."
            } else if has(&["PARTNER", "LOAN"]) {
                "It looks like money put in by you or family, which is not income and shouldn't be taxed."
            } else if has(&["INTEREST"]) {
                "It looks like bank interest, which is taxable income but has no GST."
            } else {
                "It could be a customer payment or money you put in yourself, and those are taxed very differently."
            }
        } else if has(&["SUPERMARKET", "GROCER", "ATM", "CAF"]) {
            "Shopping, cafes and cash withdrawals are usually personal, so they bring nothing off the tax."
        } else if has(&["FUEL", "MOTOR"]) {
            "Fuel and vehicle costs can be claimed for the business share of the use, so keep a record of the business trips."
        } else if has(&[
            "INSURANCE",
            "MOBILE",
            "INTERNET",
            "SUBSCRIPTION",
            "LICENCE",
            "LEVY",
        ]) {
            "It looks like a regular business running cost, which comes off the tax if it is for the business."
        } else {
            "Whether it was for the business decides whether it reduces your tax."
        };
        format!(
            "{what} is counted as {} until you say what it was. {guess}{for_business} If part of it was personal, claim only the business share.{saving_note}",
            if money_in {
                "income"
            } else {
                "a personal cost"
            }
        )
    } else {
        format!(
            "This item can change the tax worked out for you, and {} is the line it is about. Check the supporting paperwork before answering, and ask your accountant if you aren't sure.{saving_note}",
            what.to_lowercase()
        )
    }
}

#[cfg(test)]
mod demo_tests {
    use super::*;

    #[test]
    fn demo_explanations_read_like_a_model_wrote_them() {
        let text = demo_explanation(
            "Item: Is this a payment to IRD?\nWhy it matters: x\nThe business: coffee cart\nBank line: money out, $1500, \"INLAND REVENUE INC TAX 2026\"\nAnswering could lower the tax by about $1500.\n",
        );
        assert!(text.contains("income tax"), "{text}");
        assert!(text.contains("$1500 line"), "{text}");
        assert!(text.contains("about $1500"), "{text}");
        assert!(!text.contains("test explanation"));
    }
}
