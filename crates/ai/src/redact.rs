//! What leaves the server (ADR 009, "What leaves the server"). [`request`] is pure and is the only
//! way to build a [`SuggestRequest`]: its fields are private, so no other code can put a date,
//! balance, account number, name or database id into one.
//!
//! A description is redacted by these rules, in order:
//! 1. The bank's separate particulars, code and reference fields are dropped. No parser keeps
//!    them apart yet (each joins the text fields into one description), so the server passes
//!    only the description.
//! 2. NZ bank account numbers (`BB-bbbb-AAAAAAA-SS`, with or without separators) become `[acct]`.
//! 3. IRD numbers (8 or 9 digits, or `NNN-NNN-NNN`) become `[ird]`.
//! 4. Email addresses, phone numbers and URLs become `[email]`, `[phone]` and `[url]`. A URL has
//!    a scheme, starts `www.` or has a path; a bare domain such as `NETFLIX.COM` is a merchant's
//!    name and stays.
//! 5. Any other run of 6 or more digits becomes `#`.
//! 6. The private names (the owner's, any other names on the account, and the business's) are
//!    removed as whole words, ignoring case, with their initials-and-surname forms (`Q MARSH`,
//!    `MARSH Q`).
//! 7. Runs of spaces collapse, and the result is trimmed to 60 characters.

use acct_core::coding::Direction;
use acct_core::{GstCode, Money};

use crate::Category;

/// The longest description, activity phrase or category name sent.
pub const MAX_CHARS: usize = 60;
/// The most already-coded lines sent as examples.
pub const MAX_EXAMPLES: usize = 5;

/// A bank line to suggest a category for.
#[derive(Debug, Clone, Copy)]
pub struct LineInput<'a> {
    /// Signed as the bank shows it: positive is money in.
    pub amount: Money,
    pub description: &'a str,
}

/// An already-coded line of the same business, shown to the model as an example.
#[derive(Debug, Clone, Copy)]
pub struct ExampleInput<'a> {
    pub amount: Money,
    pub description: &'a str,
    pub category: &'a str,
    pub gst: GstCode,
}

/// Everything [`request`] may draw on.
#[derive(Debug, Clone, Copy)]
pub struct Input<'a> {
    pub lines: &'a [LineInput<'a>],
    pub categories: &'a [Category],
    pub examples: &'a [ExampleInput<'a>],
    /// The owner's short phrase for what the business does, such as "candle maker".
    pub activity: Option<&'a str>,
    /// Names to remove: the owner's, any other names on the account, and the business's.
    pub private_names: &'a [&'a str],
}

/// One line as sent: a reference within the request, never a database id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentLine {
    reference: u32,
    direction: Direction,
    dollars: i64,
    description: String,
}

impl SentLine {
    pub fn reference(&self) -> u32 {
        self.reference
    }
    pub fn direction(&self) -> Direction {
        self.direction
    }
    /// The size of the amount, rounded to whole dollars.
    pub fn dollars(&self) -> i64 {
        self.dollars
    }
    pub fn description(&self) -> &str {
        &self.description
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentExample {
    direction: Direction,
    dollars: i64,
    description: String,
    category: String,
    gst: GstCode,
}

impl SentExample {
    pub fn direction(&self) -> Direction {
        self.direction
    }
    pub fn dollars(&self) -> i64 {
        self.dollars
    }
    pub fn description(&self) -> &str {
        &self.description
    }
    pub fn category(&self) -> &str {
        &self.category
    }
    pub fn gst(&self) -> GstCode {
        self.gst
    }
}

/// Exactly what a suggester may send. Built only by [`request`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestRequest {
    lines: Vec<SentLine>,
    categories: Vec<Category>,
    examples: Vec<SentExample>,
    activity: Option<String>,
}

impl SuggestRequest {
    pub fn lines(&self) -> &[SentLine] {
        &self.lines
    }
    pub fn categories(&self) -> &[Category] {
        &self.categories
    }
    pub fn examples(&self) -> &[SentExample] {
        &self.examples
    }
    pub fn activity(&self) -> Option<&str> {
        self.activity.as_deref()
    }
}

/// Builds the request. Line `i` of `input.lines` gets reference `i + 1`. Lines with a nil amount
/// are left out (they keep their reference number, so the numbering still matches the input).
pub fn request(input: &Input<'_>) -> SuggestRequest {
    let names = name_forms(input.private_names);
    let clean = |text: &str| redact_with(text, &names);
    let lines = input
        .lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            Some(SentLine {
                reference: u32::try_from(i + 1).expect("a request has few lines"),
                direction: Direction::of(l.amount)?,
                dollars: dollars(l.amount),
                description: clean(l.description),
            })
        })
        .collect();
    let categories = input
        .categories
        .iter()
        .map(|c| Category {
            key: c.key.clone(),
            name: clean(&c.name),
            direction: c.direction,
        })
        .collect();
    let examples = input
        .examples
        .iter()
        .filter_map(|e| {
            Some(SentExample {
                direction: Direction::of(e.amount)?,
                dollars: dollars(e.amount),
                description: clean(e.description),
                category: e.category.to_owned(),
                gst: e.gst,
            })
        })
        .take(MAX_EXAMPLES)
        .collect();
    let activity = input.activity.map(clean).filter(|a| !a.is_empty());
    SuggestRequest {
        lines,
        categories,
        examples,
        activity,
    }
}

/// A description redacted by rules 2 to 7.
pub fn description(text: &str, private_names: &[&str]) -> String {
    redact_with(text, &name_forms(private_names))
}

fn dollars(amount: Money) -> i64 {
    amount.round_to_dollars().abs()
}

fn redact_with(text: &str, names: &[Vec<String>]) -> String {
    let text = tokens(text);
    let text = numbers(&text);
    let text = remove_names(&text, names);
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .chars()
        .take(MAX_CHARS)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// Rule 4's emails and URLs, which are whole whitespace-separated words.
fn tokens(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            if is_email(word) {
                "[email]"
            } else if is_url(word) {
                "[url]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_email(word: &str) -> bool {
    match word.split_once('@') {
        Some((user, domain)) => !user.is_empty() && domain.contains('.'),
        None => false,
    }
}

fn is_url(word: &str) -> bool {
    let w = word.to_ascii_lowercase();
    w.starts_with("http://")
        || w.starts_with("https://")
        || w.starts_with("www.")
        || (w.contains('.')
            && w.split_once('/')
                .is_some_and(|(host, _)| host.contains('.') && !host.is_empty()))
}

/// Rules 2, 3, 4 (phones) and 5, on runs of digits joined by single spaces or hyphens.
fn numbers(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let plus = chars[i] == '+' && chars.get(i + 1).is_some_and(char::is_ascii_digit);
        if !(chars[i].is_ascii_digit() || plus) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // The span: digit groups, each joined to the next by one space or hyphen.
        let start = i;
        if plus {
            i += 1;
        }
        let mut groups: Vec<String> = Vec::new();
        loop {
            let mut group = String::new();
            while i < chars.len() && chars[i].is_ascii_digit() {
                group.push(chars[i]);
                i += 1;
            }
            groups.push(group);
            let joined = i + 1 < chars.len()
                && (chars[i] == ' ' || chars[i] == '-')
                && chars[i + 1].is_ascii_digit();
            if !joined {
                break;
            }
            i += 1;
        }
        let span: String = chars[start..i].iter().collect();
        out.push_str(&classify(&span, plus, &groups));
    }
    out
}

fn classify(span: &str, plus: bool, groups: &[String]) -> String {
    let lens: Vec<usize> = groups.iter().map(String::len).collect();
    let total: usize = lens.iter().sum();
    let first = groups[0].chars().next();

    // Rule 2: a bank account number.
    if matches!(lens.as_slice(), [2, 4, 7, 2 | 3])
        || (lens.len() == 1 && (15..=16).contains(&total))
    {
        return "[acct]".to_owned();
    }
    // Rule 3: an IRD number.
    if !plus
        && (matches!(lens.as_slice(), [3, 3, 3] | [2, 3, 3])
            || (lens.len() == 1 && (8..=9).contains(&total)))
    {
        return "[ird]".to_owned();
    }
    // Rule 4: a phone number, starting 0 or +64.
    let phone_start = if plus {
        groups[0].starts_with("64")
    } else {
        first == Some('0')
    };
    if phone_start && (8..=12).contains(&total) {
        return "[phone]".to_owned();
    }
    // Rule 5: long runs of digits.
    if lens.iter().all(|&l| l < 6) {
        return span.to_owned();
    }
    let mut out = String::new();
    let mut rest = span;
    if plus {
        out.push('+');
        rest = &rest[1..];
    }
    let mut group = String::new();
    for c in rest.chars().chain(std::iter::once('\0')) {
        if c.is_ascii_digit() {
            group.push(c);
            continue;
        }
        out.push_str(if group.len() >= 6 { "#" } else { &group });
        group.clear();
        if c != '\0' {
            out.push(c);
        }
    }
    out
}

/// Each private name as the word sequences to remove, longest first.
fn name_forms(names: &[&str]) -> Vec<Vec<String>> {
    let mut forms: Vec<Vec<String>> = Vec::new();
    for name in names {
        let words = words_of(name);
        let Some((last, given)) = words.split_last() else {
            continue;
        };
        let initials: Vec<String> = given
            .iter()
            .filter_map(|w| w.chars().next().map(String::from))
            .collect();
        let mut add = |f: Vec<String>| {
            if !f.is_empty() && !forms.contains(&f) {
                forms.push(f);
            }
        };
        add(words.clone());
        if !given.is_empty() {
            add([&[last.clone()][..], given].concat());
            add([&initials[..], &[last.clone()][..]].concat());
            add([&[last.clone()][..], &initials[..]].concat());
        }
    }
    forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
    forms
}

fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_uppercase)
        .collect()
}

/// Rule 6: removes each form where its words appear consecutively, as whole words. Words may be
/// separated by anything but letters and digits, so `MARSH, Q` and `Q.MARSH` match too.
fn remove_names(text: &str, forms: &[Vec<String>]) -> String {
    if forms.is_empty() {
        return text.to_owned();
    }
    // The words of `text`, with their byte ranges.
    let mut words: Vec<(usize, usize, String)> = Vec::new();
    let mut start = None;
    for (i, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        match (c.is_alphanumeric(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                words.push((s, i, text[s..i].to_uppercase()));
                start = None;
            }
            _ => {}
        }
    }
    let mut cut = vec![false; text.len()];
    let mut taken = vec![false; words.len()];
    for form in forms {
        let n = form.len();
        let mut i = 0;
        while i + n <= words.len() {
            let fits = (0..n).all(|k| !taken[i + k] && words[i + k].2 == form[k]);
            if fits {
                for t in taken.iter_mut().skip(i).take(n) {
                    *t = true;
                }
                for c in cut.iter_mut().take(words[i + n - 1].1).skip(words[i].0) {
                    *c = true;
                }
                i += n;
            } else {
                i += 1;
            }
        }
    }
    text.char_indices()
        .filter(|(i, _)| !cut[*i])
        .map(|(_, c)| c)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(text: &str) -> String {
        description(text, &[])
    }

    #[test]
    fn rule_2_bank_account_numbers() {
        assert_eq!(r("TRANSFER TO 12-3456-7654321-00"), "TRANSFER TO [acct]");
        assert_eq!(r("TRANSFER TO 12 3456 7654321 001"), "TRANSFER TO [acct]");
        assert_eq!(r("TRANSFER TO 123456765432100"), "TRANSFER TO [acct]");
        assert_eq!(r("TFR 1234567654321001 FROM"), "TFR [acct] FROM");
    }

    #[test]
    fn rule_3_ird_numbers() {
        assert_eq!(r("IRD 123-456-789 GST"), "IRD [ird] GST");
        assert_eq!(r("IRD 12-345-678"), "IRD [ird]");
        assert_eq!(r("IRD 123456789"), "IRD [ird]");
        assert_eq!(r("IRD 12345678 INCOME TAX"), "IRD [ird] INCOME TAX");
    }

    #[test]
    fn rule_4_emails_phones_and_urls() {
        assert_eq!(r("PAID q.marsh@example.co.nz"), "PAID [email]");
        assert_eq!(r("CALL 021 123 4567"), "CALL [phone]");
        assert_eq!(r("CALL 09-123 4567 NOW"), "CALL [phone] NOW");
        assert_eq!(r("CALL +64 21 123 4567"), "CALL [phone]");
        assert_eq!(r("SEE https://example.com/inv?id=3"), "SEE [url]");
        assert_eq!(r("SEE www.example.co.nz"), "SEE [url]");
        assert_eq!(r("SEE example.co.nz/pay"), "SEE [url]");
        // A bare domain is a merchant's name.
        assert_eq!(r("NETFLIX.COM"), "NETFLIX.COM");
    }

    #[test]
    fn rule_5_long_runs_of_digits() {
        assert_eq!(r("CARD 4567 INV1234567"), "CARD 4567 INV#");
        assert_eq!(r("REF 12 345678"), "REF 12 #");
        assert_eq!(r("Z ENERGY 2025 08 22"), "Z ENERGY 2025 08 22");
        assert_eq!(r("POS W/D 12345"), "POS W/D 12345");
    }

    #[test]
    fn rule_6_names_and_their_initial_forms() {
        let names = ["Quinn Marsh", "Marsh Hollow Candles"];
        let d = |t: &str| description(t, &names);
        assert_eq!(d("Q MARSH T/A MARSH HOLLOW CANDLES"), "T/A");
        assert_eq!(d("FROM QUINN MARSH"), "FROM");
        assert_eq!(d("FROM MARSH, Q"), "FROM");
        assert_eq!(d("FROM marsh quinn TOPUP"), "FROM TOPUP");
        assert_eq!(d("FROM Q.MARSH"), "FROM");
        // Whole words only.
        assert_eq!(d("MARSHALL Q PLUMBING"), "MARSHALL Q PLUMBING");
        // A single-word name is still removed.
        assert_eq!(description("PAY TO KOWHAI", &["Kowhai"]), "PAY TO");
    }

    #[test]
    fn rule_7_spaces_collapse_and_the_text_is_trimmed() {
        assert_eq!(r("  A    B  "), "A B");
        let long = "X".repeat(80);
        assert_eq!(r(&long).chars().count(), MAX_CHARS);
    }

    #[test]
    fn amounts_are_whole_dollars_and_lines_are_numbered() {
        let lines = [
            LineInput {
                amount: Money::from_cents(-4_550),
                description: "Z ENERGY",
            },
            LineInput {
                amount: Money::ZERO,
                description: "NIL",
            },
            LineInput {
                amount: Money::from_cents(12_049),
                description: "SALE",
            },
        ];
        let req = request(&Input {
            lines: &lines,
            categories: &[],
            examples: &[],
            activity: Some("  candle   maker "),
            private_names: &[],
        });
        let sent: Vec<_> = req
            .lines()
            .iter()
            .map(|l| (l.reference(), l.direction(), l.dollars()))
            .collect();
        assert_eq!(sent, vec![(1, Direction::Out, 46), (3, Direction::In, 120)]);
        assert_eq!(req.activity(), Some("candle maker"));
    }

    #[test]
    fn names_are_removed_from_examples_categories_and_activity_too() {
        let names = ["Q Marsh"];
        let categories = [Category {
            key: "720".to_owned(),
            name: "Loan from Q Marsh".to_owned(),
            direction: Direction::In,
        }];
        let examples = [ExampleInput {
            amount: Money::from_cents(-1_000),
            description: "Q MARSH 12-3456-7654321-00",
            category: "960",
            gst: GstCode::None,
        }];
        let req = request(&Input {
            lines: &[],
            categories: &categories,
            examples: &examples,
            activity: Some("Q Marsh's candles"),
            private_names: &names,
        });
        assert_eq!(req.categories()[0].name, "Loan from");
        assert_eq!(req.examples()[0].description(), "[acct]");
        assert_eq!(req.activity(), Some("'s candles"));
    }

    #[test]
    fn at_most_five_examples() {
        let examples = vec![
            ExampleInput {
                amount: Money::from_cents(-100),
                description: "X",
                category: "c",
                gst: GstCode::Standard,
            };
            9
        ];
        let req = request(&Input {
            lines: &[],
            categories: &[],
            examples: &examples,
            activity: None,
            private_names: &[],
        });
        assert_eq!(req.examples().len(), MAX_EXAMPLES);
    }
}
