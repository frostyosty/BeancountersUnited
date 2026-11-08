//! "Explain better": a longer, plain-English explanation of one Save tax card, tailored to the
//! owner's situation. Like [`crate::redact::request`], [`request`] is the only way to build an
//! [`ExplainRequest`], and it redacts every description. Nothing here computes an amount.

use acct_core::Money;

use crate::redact::{self, MAX_CHARS};

/// Our own instructions. No business's data goes here.
pub(crate) const INSTRUCTIONS: &str = "\
You explain one item from a New Zealand sole trader's tax-saving checklist to someone who is not \
an accountant. Using only the facts given, say in 3 to 5 short sentences what the item means, \
why it affects the tax they would pay, and what they should check or have to hand before \
answering. Be specific to their situation, in plain words, and mention amounts only as given. \
Descriptions are bank statement text with private details replaced by placeholders such as \
[acct], [ird], [phone], [email], [url] and #. Do not invent facts, do not give a final ruling, \
and if the facts aren't enough to be sure, say what would settle it. No lists, headings or \
markdown.";

/// What to explain. The server fills this from its own copy of the card, never from the browser.
#[derive(Debug, Clone, Copy)]
pub struct Input<'a> {
    /// What the card asks, in our own words, such as "Is this a payment to IRD?".
    pub heading: &'a str,
    /// Our own wording for why the card matters.
    pub background: &'a str,
    /// The bank lines the card is about: signed, as the bank shows them.
    pub lines: &'a [(Money, &'a str)],
    /// The most the card could save, in whole dollars, and whether it is only a best case.
    pub saving_dollars: i64,
    pub best_case: bool,
    /// The owner's short phrase for what the business does.
    pub activity: Option<&'a str>,
    /// Names to remove from descriptions.
    pub private_names: &'a [&'a str],
}

/// A request to explain a card, holding only what redaction let through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplainRequest {
    facts: String,
}

impl ExplainRequest {
    /// The user message sent to the model.
    pub fn facts(&self) -> &str {
        &self.facts
    }
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_CHARS * 4).collect()
}

pub fn request(input: &Input<'_>) -> ExplainRequest {
    let mut facts = format!(
        "Item: {}\nWhy it matters: {}\n",
        input.heading, input.background
    );
    if let Some(activity) = input.activity {
        let activity: String = activity.chars().take(MAX_CHARS).collect();
        facts.push_str(&format!("The business: {activity}\n"));
    }
    for (amount, description) in input.lines {
        let dollars = amount.cents().abs() / 100;
        let direction = if amount.cents() >= 0 {
            "money in"
        } else {
            "money out"
        };
        let description = redact::description(description, input.private_names);
        facts.push_str(&format!(
            "Bank line: {direction}, ${dollars}, \"{description}\"\n"
        ));
    }
    if input.saving_dollars > 0 {
        let kind = if input.best_case { "at most" } else { "about" };
        facts.push_str(&format!(
            "Answering could lower the tax by {kind} ${}.\n",
            input.saving_dollars
        ));
    }
    ExplainRequest {
        facts: clip(&facts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_are_redacted_and_amounts_are_whole_dollars() {
        let lines = [(
            Money::from_cents(-12_345),
            "Pay Q MARSH 12-3456-1234567-00 ref 987654321",
        )];
        let r = request(&Input {
            heading: "Is this a payment to IRD?",
            background: "Tax already paid comes off what you owe.",
            lines: &lines,
            saving_dollars: 40,
            best_case: true,
            activity: Some("candle maker"),
            private_names: &["Q Marsh"],
        });
        let f = r.facts();
        assert!(f.contains("money out, $123,"), "{f}");
        assert!(
            !f.contains("MARSH") && !f.contains("1234567") && !f.contains("987654321"),
            "{f}"
        );
        assert!(f.contains("at most $40"));
    }
}
