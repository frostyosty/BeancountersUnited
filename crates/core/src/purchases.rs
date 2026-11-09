//! Purchases paid in parts (M23, ADR 017, 14; `docs/domain.md`, "Purchases paid in parts").
//!
//! The $200 and $1,000 supply-information tiers go by the whole **supply**, not by each payment, so
//! a deposit and a balance that together pay for one job are tested as one. A *purchase* groups the
//! payments for one supply with the supply's total.
//!
//! - [`Supply`] is what core's GST rule reads ([`crate::coding::coded_lines`] and
//!   [`crate::coding::gst_totals`]): the supply's total and whether its information is confirmed.
//!   A payment in no purchase is its own supply ([`Supply::of_line`]), which gives exactly the rule
//!   that applied before purchases existed.
//! - [`check_purchase`] returns every rule a purchase breaks, by name. The server checks again, and
//!   adds the rules that need its data (finalised years, bills).
//! - [`possible_splits`] flags payments that look like one purchase split up. It is pure and worked
//!   out when read, never stored.
//!
//! Nothing here posts anything. Amounts are integer cents.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use serde::Serialize;
use thiserror::Error;

use crate::chart::GstCode;
use crate::coding::{BankLine, Coding, SUPPLY_INFO_THRESHOLD, WithdrawalCoding};
use crate::money::Money;

/// How far apart the payments of one purchase may fall.
pub const PURCHASE_SPAN_DAYS: i64 = 365;

/// How close together the payments of a flagged purchase must be, for the signs that go by dates.
pub const SPLIT_WINDOW_DAYS: i64 = 60;

/// One supply, as the GST rule sees it: its GST-inclusive value and whether the owner has
/// confirmed they hold the supplier's taxable supply information for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Supply {
    /// The supply's GST-inclusive value, positive for money out.
    pub total: Money,
    pub info_confirmed: Option<NaiveDate>,
}

impl Supply {
    /// A payment in no purchase: its own supply, worth what left the bank. This is the rule as it
    /// was before purchases, so a payment in no purchase posts exactly as it always did.
    pub fn of_line(line: &BankLine<'_>, info_confirmed: Option<NaiveDate>) -> Supply {
        Supply {
            total: -line.amount,
            info_confirmed,
        }
    }
}

// -------------------------------------------------------------------------------------------------
// The rules on a purchase
// -------------------------------------------------------------------------------------------------

/// A payment offered to a purchase. `amount` is signed as the bank shows it, so money out is
/// negative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurchaseLine<'a> {
    pub id: &'a str,
    pub date: NaiveDate,
    pub amount: Money,
}

/// A rule a purchase breaks.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PurchaseError {
    #[error("a purchase needs at least one payment")]
    NoLines,
    #[error("payment {line_id} is listed more than once")]
    LineRepeated { line_id: String },
    #[error("payment {line_id} is money in, but a purchase is made of money out")]
    NotMoneyOut { line_id: String },
    #[error("payment {line_id} is already in another purchase")]
    InAnotherPurchase { line_id: String },
    #[error("the total ({total}) is less than the payments add up to ({paid})")]
    TotalBelowPayments { total: Money, paid: Money },
    #[error("payment {line_id} is more than {PURCHASE_SPAN_DAYS} days after the earliest")]
    TooSpread { line_id: String },
}

/// Every rule that `lines` and `total` break, in a fixed order (one entry per offending line, in
/// the order the lines were given), or nothing if it's a valid purchase.
///
/// - one or more payments, each listed once;
/// - every payment is money out, and in no other purchase (`in_other_purchases` holds the ids that
///   already are);
/// - the total is at least what the payments add up to (it may be more: part paid another way);
/// - every payment is within [`PURCHASE_SPAN_DAYS`] days of the earliest.
///
/// A finalised year and a payment held by a confirmed bill are the server's rules.
pub fn check_purchase(
    lines: &[PurchaseLine<'_>],
    total: Money,
    in_other_purchases: &BTreeSet<String>,
) -> Vec<PurchaseError> {
    if lines.is_empty() {
        return vec![PurchaseError::NoLines];
    }
    let mut errors = Vec::new();
    let mut seen = BTreeSet::new();
    let mut paid: i128 = 0;
    for l in lines {
        if !seen.insert(l.id) {
            errors.push(PurchaseError::LineRepeated {
                line_id: l.id.to_owned(),
            });
            continue;
        }
        if l.amount >= Money::ZERO {
            errors.push(PurchaseError::NotMoneyOut {
                line_id: l.id.to_owned(),
            });
        } else {
            paid -= i128::from(l.amount.cents());
        }
        if in_other_purchases.contains(l.id) {
            errors.push(PurchaseError::InAnotherPurchase {
                line_id: l.id.to_owned(),
            });
        }
    }
    if i128::from(total.cents()) < paid {
        errors.push(PurchaseError::TotalBelowPayments {
            total,
            paid: Money::from_cents(i64::try_from(paid).unwrap_or(i64::MAX)),
        });
    }
    if let Some(earliest) = lines.iter().map(|l| l.date).min() {
        let mut flagged = BTreeSet::new();
        for l in lines {
            if (l.date - earliest).num_days() > PURCHASE_SPAN_DAYS && flagged.insert(l.id) {
                errors.push(PurchaseError::TooSpread {
                    line_id: l.id.to_owned(),
                });
            }
        }
    }
    errors
}

// -------------------------------------------------------------------------------------------------
// Names and references
// -------------------------------------------------------------------------------------------------

/// Words that carry no name, dropped from a supplier's name before it's compared with a bank
/// description (ADR 017, 8).
pub const NAME_STOP_WORDS: &[&str] = &[
    "LTD", "LIMITED", "NZ", "NEW", "ZEALAND", "THE", "AND", "CO", "COMPANY", "GROUP", "HOLDINGS",
    "TRADING", "TA",
];

/// How a bank starts a description, before the payee: dropped when finding the payee.
const BANK_PREFIXES: &[&str] = &["POS", "EFTPOS", "AP", "DD", "VISA", "DEBIT", "CARD"];

/// Words that say a payment is one part of a larger one.
const INSTALMENT_WORDS: &[&str] = &[
    "DEPOSIT",
    "DEP",
    "BALANCE",
    "BAL",
    "INSTALMENT",
    "INSTAL",
    "PART",
    "FINAL",
];

/// Upper case, with macrons folded (`Ō` to `O`), since banks drop them.
pub fn fold_upper(s: &str) -> String {
    s.chars()
        .flat_map(char::to_uppercase)
        .filter(|&c| c != '\u{0304}')
        .map(|c| match c {
            'Ā' => 'A',
            'Ē' => 'E',
            'Ī' => 'I',
            'Ō' => 'O',
            'Ū' => 'U',
            c => c,
        })
        .collect()
}

/// The words of a name: folded, split on anything that isn't a letter or digit.
fn words_of(s: &str) -> Vec<String> {
    fold_upper(s)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_letters(w: &str) -> bool {
    !w.is_empty() && w.chars().all(char::is_alphabetic)
}

/// Who a bank description pays: its first word of 3 or more letters once bank prefixes (`POS`,
/// `EFTPOS`, `AP`, `DD`, `VISA`, `DEBIT`, `CARD`), anything with a digit (card numbers, dates,
/// references), masked numbers and the words in [`NAME_STOP_WORDS`] are dropped. Two payments share
/// a payee when their keys are equal.
pub fn payee_key(description: &str) -> Option<String> {
    fold_upper(description)
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| !matches!(c, '\'' | '’'))
                .collect::<String>()
        })
        .map(|t| {
            t.trim_matches(|c: char| !c.is_alphanumeric() && c != '*')
                .to_owned()
        })
        .filter(|t| {
            !t.is_empty()
                && !BANK_PREFIXES.contains(&t.as_str())
                && !NAME_STOP_WORDS.contains(&t.as_str())
        })
        .find(|t| t.chars().count() >= 3 && is_letters(t))
}

/// Whether a bank description names a supplier (ADR 017, 8): a word of the supplier's name (stop
/// words dropped) of 3 or more letters appears whole in the description, or a description word of 5
/// or more letters starts one of them (banks cut names short), or the invoice number's digits (4 or
/// more, leading zeros dropped) appear in it.
pub fn has_name_evidence(supplier_name: &str, invoice_number: &str, description: &str) -> bool {
    let supplier: Vec<String> = words_of(supplier_name)
        .into_iter()
        .filter(|w| {
            w.chars().count() >= 3 && is_letters(w) && !NAME_STOP_WORDS.contains(&w.as_str())
        })
        .collect();
    let text = words_of(description);
    let by_name = supplier.iter().any(|s| {
        text.iter().any(|t| {
            t == s || (t.chars().count() >= 5 && is_letters(t) && s.starts_with(t.as_str()))
        })
    });
    if by_name {
        return true;
    }
    let wanted: BTreeSet<String> = digit_runs(invoice_number)
        .into_iter()
        .map(|r| r.trim_start_matches('0').to_owned())
        .filter(|r| r.len() >= 4)
        .collect();
    digit_runs(description)
        .into_iter()
        .any(|r| wanted.contains(r.trim_start_matches('0')))
}

/// Every maximal run of ASCII digits in `s`.
fn digit_runs(s: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            runs.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    runs
}

/// Whether eight digits read as a date (`yyyymmdd` or `ddmmyyyy`).
fn looks_like_date(run: &str) -> bool {
    if run.len() != 8 {
        return false;
    }
    let n = |r: std::ops::Range<usize>| run[r].parse::<u32>().unwrap_or(0);
    let ymd = (1900..=2099).contains(&n(0..4))
        && (1..=12).contains(&n(4..6))
        && (1..=31).contains(&n(6..8));
    let dmy = (1..=31).contains(&n(0..2))
        && (1..=12).contains(&n(2..4))
        && (1900..=2099).contains(&n(4..8));
    ymd || dmy
}

/// The reference numbers in a bank description: runs of 4 or more digits, such as an invoice or job
/// number. Card numbers (masked, after `VISA` or `CARD`, or in groups with hyphens), dates and
/// phone-like groups don't count.
fn reference_digits(description: &str) -> BTreeSet<String> {
    let folded = fold_upper(description);
    let mut out = BTreeSet::new();
    let mut after_card = false;
    for raw in folded.split_whitespace() {
        let token = raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '*');
        let was_after_card = after_card;
        after_card = matches!(token, "VISA" | "DEBIT" | "CARD" | "EFTPOS");
        if was_after_card || token.is_empty() || token.contains(['*', '/', '.']) {
            continue;
        }
        let parts: Vec<&str> = token.split('-').collect();
        if parts.len() > 1 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
            continue;
        }
        for part in parts {
            for run in digit_runs(part) {
                if run.len() >= 4 && run.len() <= 12 && !looks_like_date(&run) {
                    out.insert(run);
                }
            }
        }
    }
    out
}

/// Whether a bank description says the payment is one part of a larger one: an instalment word
/// (`DEPOSIT`, `BAL`, `PART`...), or `1/2`, `2 OF 3` and the like.
fn has_instalment_words(description: &str) -> bool {
    let folded = fold_upper(description);
    let tokens: Vec<&str> = folded
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric() && c != '/'))
        .collect();
    let small = |t: &str| {
        (1..=2).contains(&t.len()) && t.chars().all(|c| c.is_ascii_digit()) && !t.starts_with('0')
    };
    for (i, t) in tokens.iter().enumerate() {
        if INSTALMENT_WORDS.contains(t) {
            return true;
        }
        if let Some((n, m)) = t.split_once('/') {
            let one = |s: &str| s.len() == 1 && s.chars().all(|c| c.is_ascii_digit());
            if one(n) && one(m) {
                let (n, m): (u32, u32) = (n.parse().unwrap_or(0), m.parse().unwrap_or(0));
                if n >= 1 && m >= 2 && n <= m {
                    return true;
                }
            }
        }
        if small(t)
            && tokens.get(i + 1) == Some(&"OF")
            && tokens.get(i + 2).is_some_and(|m| small(m))
        {
            return true;
        }
    }
    false
}

// -------------------------------------------------------------------------------------------------
// Spotting purchases paid in parts
// -------------------------------------------------------------------------------------------------

/// A bank line offered to [`possible_splits`].
#[derive(Debug, Clone)]
pub struct SplitLine<'a> {
    pub id: &'a str,
    pub date: NaiveDate,
    /// Signed as the bank shows it: money out is negative.
    pub amount: Money,
    pub description: &'a str,
    /// How the line is coded, or `None` if it isn't yet.
    pub coding: Option<&'a Coding>,
    /// A duplicate, either half of a transfer, or held by a confirmed bill: never flagged.
    pub excluded: bool,
}

/// What [`possible_splits`] needs to know of a bill. The payment it paid is found by amount, date
/// and the supplier's name.
#[derive(Debug, Clone)]
pub struct SplitBill<'a> {
    pub supplier_name: &'a str,
    pub supplier_gst_number: &'a str,
    pub date: NaiveDate,
    pub invoice_number: &'a str,
    pub total: Money,
}

/// Why a set of payments was flagged, strongest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "sign", rename_all = "snake_case")]
pub enum SplitSign {
    /// They share a number of 4 or more digits (an invoice or job number), within 60 days.
    SameReference { digits: String },
    /// One says `DEPOSIT`, `BAL`, `1/2` and the like, within 60 days.
    InstalmentWords,
    /// Two or more payments to the same payee on the same day.
    SameDay,
    /// Two or more bills from one GST number, each $200 or less, together over $200, with the same
    /// date or invoice numbers one apart: the payments that paid them.
    SplitBills,
}

impl SplitSign {
    fn rank(&self) -> u8 {
        match self {
            SplitSign::SameReference { .. } => 0,
            SplitSign::InstalmentWords => 1,
            SplitSign::SameDay => 2,
            SplitSign::SplitBills => 3,
        }
    }
}

/// A set of payments that may be one purchase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SplitFlag {
    /// Bank line ids, oldest first (ties by id). A line is in at most one flag.
    pub lines: Vec<String>,
    pub sign: SplitSign,
}

struct Fact<'a> {
    id: &'a str,
    date: NaiveDate,
    /// What left the bank, positive.
    cents: i64,
    payee: Option<String>,
    digits: BTreeSet<String>,
    words: bool,
}

/// A candidate set, as indexes into the sorted facts.
struct Candidate {
    idx: Vec<usize>,
    sign: SplitSign,
    needs_words: bool,
}

/// The spending line a flag may cover: money out of $200 or less, in no purchase, not excluded, and
/// coded standard GST or not coded yet (any other coding claims no GST, so it can't matter).
fn considered(l: &SplitLine<'_>, in_purchases: &BTreeSet<String>) -> bool {
    let claims = match l.coding {
        None => true,
        Some(Coding::Out(
            WithdrawalCoding::Expense { gst, .. }
            | WithdrawalCoding::AssetPurchase { gst, .. }
            | WithdrawalCoding::PartPrivate { gst, .. },
        )) => *gst == GstCode::Standard,
        Some(_) => false,
    };
    claims
        && !l.excluded
        && l.amount < Money::ZERO
        && -l.amount <= SUPPLY_INFO_THRESHOLD
        && !in_purchases.contains(l.id)
}

/// Payments that look like one purchase split up (ADR 017, 14). The owner is asked "Were these one
/// purchase?" and nothing posts until they answer.
///
/// - `lines`: the business's bank lines (any may be left in: only [`considered`] ones count).
/// - `in_purchases`: the line ids already in a purchase.
/// - `separate`: the owner's "Separate purchases" answers, as line-id sets; such a set never flags
///   again (a new line makes a different set, which can).
/// - `bills`: the business's bills, for the split-bills sign.
///
/// A flag is payments to one payee ([`payee_key`]), each $200 or less and together over $200, with
/// one of: a shared reference number and the same 60 days; instalment words and the same 60 days;
/// the same day; or (bills) two or more bills from one GST number, each $200 or less, together over
/// $200, dated the same or numbered one apart, whose payments are found by amount, date and name.
/// Regular payments with none of these signs, like a weekly café, never flag.
///
/// The result is strongest sign first, then earliest date; a line is in at most one flag, and
/// nothing depends on the order the inputs came in.
pub fn possible_splits(
    lines: &[SplitLine<'_>],
    in_purchases: &BTreeSet<String>,
    separate: &[Vec<String>],
    bills: &[SplitBill<'_>],
) -> Vec<SplitFlag> {
    let answered: BTreeSet<Vec<String>> = separate
        .iter()
        .map(|s| {
            let mut v = s.clone();
            v.sort();
            v.dedup();
            v
        })
        .collect();

    let mut facts: Vec<(&SplitLine<'_>, Fact<'_>)> = lines
        .iter()
        .filter(|l| considered(l, in_purchases))
        .map(|l| {
            (
                l,
                Fact {
                    id: l.id,
                    date: l.date,
                    cents: -l.amount.cents(),
                    payee: payee_key(l.description),
                    digits: reference_digits(l.description),
                    words: has_instalment_words(l.description),
                },
            )
        })
        .collect();
    facts.sort_by(|a, b| (a.1.date, a.1.id).cmp(&(b.1.date, b.1.id)));
    facts.dedup_by(|a, b| a.1.id == b.1.id);
    let descriptions: Vec<&str> = facts.iter().map(|(l, _)| l.description).collect();
    let facts: Vec<Fact<'_>> = facts.into_iter().map(|(_, f)| f).collect();

    let mut by_payee: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, f) in facts.iter().enumerate() {
        if let Some(p) = &f.payee {
            by_payee.entry(p.as_str()).or_default().push(i);
        }
    }

    let mut used = vec![false; facts.len()];
    let mut out: Vec<SplitFlag> = Vec::new();
    let mut accept = |mut cands: Vec<Candidate>, used: &mut Vec<bool>| {
        cands.sort_by(|a, b| {
            let key = |c: &Candidate| {
                let ids: Vec<&str> = c.idx.iter().map(|&i| facts[i].id).collect();
                (facts[c.idx[0]].date, ids)
            };
            key(a).cmp(&key(b))
        });
        for c in cands {
            let idx: Vec<usize> = c.idx.iter().copied().filter(|&i| !used[i]).collect();
            let total: i64 = idx.iter().map(|&i| facts[i].cents).sum();
            if idx.len() < 2
                || total <= SUPPLY_INFO_THRESHOLD.cents()
                || (c.needs_words && !idx.iter().any(|&i| facts[i].words))
            {
                continue;
            }
            let mut sorted: Vec<String> = idx.iter().map(|&i| facts[i].id.to_owned()).collect();
            sorted.sort();
            if answered.contains(&sorted) {
                continue;
            }
            for &i in &idx {
                used[i] = true;
            }
            out.push(SplitFlag {
                lines: idx.iter().map(|&i| facts[i].id.to_owned()).collect(),
                sign: c.sign,
            });
        }
    };

    // 1. Same reference number.
    let mut cands = Vec::new();
    for group in by_payee.values() {
        let mut by_digits: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        for &i in group {
            for d in &facts[i].digits {
                by_digits.entry(d.as_str()).or_default().push(i);
            }
        }
        for (digits, idx) in by_digits {
            for cluster in windows(&idx, &facts) {
                cands.push(Candidate {
                    idx: cluster,
                    sign: SplitSign::SameReference {
                        digits: digits.to_owned(),
                    },
                    needs_words: false,
                });
            }
        }
    }
    accept(cands, &mut used);

    // 2. Instalment words.
    let mut cands = Vec::new();
    for group in by_payee.values() {
        for cluster in windows(group, &facts) {
            cands.push(Candidate {
                idx: cluster,
                sign: SplitSign::InstalmentWords,
                needs_words: true,
            });
        }
    }
    accept(cands, &mut used);

    // 3. The same day.
    let mut cands = Vec::new();
    for group in by_payee.values() {
        let mut by_day: BTreeMap<NaiveDate, Vec<usize>> = BTreeMap::new();
        for &i in group {
            by_day.entry(facts[i].date).or_default().push(i);
        }
        for (_, idx) in by_day {
            cands.push(Candidate {
                idx,
                sign: SplitSign::SameDay,
                needs_words: false,
            });
        }
    }
    accept(cands, &mut used);

    // 4. Bills from one supplier that look like one supply invoiced in pieces.
    let mut cands = Vec::new();
    for component in split_bill_groups(bills) {
        let mut taken: BTreeSet<usize> = BTreeSet::new();
        let mut idx = Vec::new();
        for b in component {
            let found = facts
                .iter()
                .enumerate()
                .filter(|(i, f)| {
                    !taken.contains(i)
                        && f.cents == b.total.cents()
                        && f.date >= b.date - chrono::Days::new(7)
                        && f.date <= b.date + chrono::Days::new(60)
                        && has_name_evidence(b.supplier_name, b.invoice_number, descriptions[*i])
                })
                .min_by_key(|(_, f)| ((f.date - b.date).num_days().abs(), f.id))
                .map(|(i, _)| i);
            if let Some(i) = found {
                taken.insert(i);
                idx.push(i);
            }
        }
        idx.sort_unstable();
        if idx.len() >= 2 {
            cands.push(Candidate {
                idx,
                sign: SplitSign::SplitBills,
                needs_words: false,
            });
        }
    }
    accept(cands, &mut used);

    out.sort_by(|a, b| {
        let first = |f: &SplitFlag| facts.iter().find(|x| x.id == f.lines[0]).map(|x| x.date);
        (a.sign.rank(), first(a), &a.lines).cmp(&(b.sign.rank(), first(b), &b.lines))
    });
    out
}

/// `idx` (already in date order) split into runs where every payment is within
/// [`SPLIT_WINDOW_DAYS`] of the run's first, keeping runs of two or more.
fn windows(idx: &[usize], facts: &[Fact<'_>]) -> Vec<Vec<usize>> {
    let mut runs: Vec<Vec<usize>> = Vec::new();
    for &i in idx {
        match runs.last_mut() {
            Some(run) if (facts[i].date - facts[run[0]].date).num_days() <= SPLIT_WINDOW_DAYS => {
                run.push(i);
            }
            _ => runs.push(vec![i]),
        }
    }
    runs.retain(|r| r.len() >= 2);
    runs
}

/// Groups of two or more bills from one GST number, each $200 or less, together over $200, joined
/// by the same date or invoice numbers one apart. Each group is sorted, and so are the groups.
fn split_bill_groups<'a, 'b>(bills: &'b [SplitBill<'a>]) -> Vec<Vec<&'b SplitBill<'a>>> {
    let gst = |b: &SplitBill<'_>| -> String {
        b.supplier_gst_number
            .chars()
            .filter(char::is_ascii_digit)
            .collect()
    };
    let mut sorted: Vec<&SplitBill<'_>> = bills
        .iter()
        .filter(|b| b.total > Money::ZERO && b.total <= SUPPLY_INFO_THRESHOLD && !gst(b).is_empty())
        .collect();
    sorted.sort_by(|a, b| {
        (gst(a), a.date, a.invoice_number, a.total).cmp(&(
            gst(b),
            b.date,
            b.invoice_number,
            b.total,
        ))
    });

    let linked = |a: &SplitBill<'_>, b: &SplitBill<'_>| -> bool {
        if gst(a) != gst(b) {
            return false;
        }
        if a.date == b.date {
            return true;
        }
        match (
            invoice_parts(a.invoice_number),
            invoice_parts(b.invoice_number),
        ) {
            (Some((pa, na)), Some((pb, nb))) => pa == pb && na.abs_diff(nb) == 1,
            _ => false,
        }
    };

    // Connected components, by walking from each unvisited bill.
    let mut component_of: Vec<Option<usize>> = vec![None; sorted.len()];
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for start in 0..sorted.len() {
        if component_of[start].is_some() {
            continue;
        }
        let id = groups.len();
        let mut stack = vec![start];
        component_of[start] = Some(id);
        let mut members = Vec::new();
        while let Some(i) = stack.pop() {
            members.push(i);
            for j in 0..sorted.len() {
                if component_of[j].is_none() && linked(sorted[i], sorted[j]) {
                    component_of[j] = Some(id);
                    stack.push(j);
                }
            }
        }
        members.sort_unstable();
        groups.push(members);
    }
    groups
        .into_iter()
        .filter(|g| {
            g.len() >= 2
                && g.iter().map(|&i| sorted[i].total.cents()).sum::<i64>()
                    > SUPPLY_INFO_THRESHOLD.cents()
        })
        .map(|g| g.into_iter().map(|i| sorted[i]).collect())
        .collect()
}

/// An invoice number as its prefix (upper case) and trailing number: `INV-3301` is `("INV-", 3301)`.
fn invoice_parts(s: &str) -> Option<(String, u64)> {
    let s = s.trim();
    let digits = s.chars().rev().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 18 {
        return None;
    }
    let (prefix, number) = s.split_at(s.len() - digits);
    Some((prefix.to_uppercase(), number.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::{Account, AccountCode, AccountType, Chart};
    use crate::coding::{CodingContext, CodingSettings, coded_lines, gst_totals};
    use crate::tax::gst::gst_in_inclusive;
    use proptest::prelude::*;

    const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
    const SETTINGS: &str =
        include_str!("../../../fixtures/practice/sole-trader-coding-settings.json");
    const EXPECTED: &str = include_str!("../../../fixtures/invoices/expected.json");

    fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn chart() -> Chart {
        let mut accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
        accounts.push(Account {
            code: code("600.01"),
            name: "Cheque account".into(),
            account_type: AccountType::Asset,
            active: true,
            default_gst: None,
        });
        Chart::new(accounts).unwrap()
    }

    fn settings() -> CodingSettings {
        serde_json::from_str(SETTINGS).unwrap()
    }

    fn repairs() -> Coding {
        Coding::Out(WithdrawalCoding::Expense {
            account: code("230"),
            gst: GstCode::Standard,
        })
    }

    /// The postings of one line, as (account, cents), under `supply`.
    fn post(
        cents: i64,
        date: &str,
        supply_total: Option<i64>,
        confirmed: bool,
    ) -> Vec<(String, i64)> {
        let chart = chart();
        let settings = settings();
        let ctx = CodingContext {
            chart: &chart,
            settings: &settings,
            gst_registered_from: Some(d("2025-08-01")),
        };
        let bank = code("600.01");
        let line = BankLine {
            bank: &bank,
            date: d(date),
            amount: Money::from_cents(-cents),
        };
        let confirmed = confirmed.then(|| d("2026-04-01"));
        let supply = match supply_total {
            None => Supply::of_line(&line, confirmed),
            Some(total) => Supply {
                total: Money::from_cents(total),
                info_confirmed: confirmed,
            },
        };
        coded_lines(&line, &repairs(), &supply, &ctx)
            .unwrap()
            .into_iter()
            .map(|l| (l.account.as_str().to_owned(), l.amount.cents()))
            .collect()
    }

    fn purchases_claimed(cents: i64, supply_total: i64, confirmed: bool) -> i64 {
        let bank = code("600.01");
        let line = BankLine {
            bank: &bank,
            date: d("2026-03-12"),
            amount: Money::from_cents(-cents),
        };
        let supply = Supply {
            total: Money::from_cents(supply_total),
            info_confirmed: confirmed.then(|| d("2026-04-01")),
        };
        gst_totals(&line, Some(&repairs()), &supply, Some(d("2025-08-01")))
            .purchases
            .cents()
    }

    // ---- Supply ------------------------------------------------------------------------------

    proptest! {
        /// A payment in no purchase posts exactly as it did before purchases existed: GST waits in
        /// 615 only over $200 and unconfirmed, and the figures foot to the line.
        #[test]
        fn of_line_is_the_old_per_line_rule(cents in 1i64..50_000_000, confirmed in any::<bool>(), day in 0u64..60) {
            let date = d("2025-09-01") + chrono::Days::new(day);
            let got = post(cents, &date.to_string(), None, confirmed);
            let tax = gst_in_inclusive(Money::from_cents(cents), 1500).cents();
            let waits = cents > 20_000 && !confirmed;
            let gst_account = if waits { "615" } else { "810" };
            let mut expected = vec![("230".to_owned(), cents - tax)];
            if tax != 0 {
                expected.push((gst_account.to_owned(), tax));
            }
            expected.push(("600.01".to_owned(), -cents));
            prop_assert_eq!(got, expected);

            let bank = code("600.01");
            let line = BankLine { bank: &bank, date, amount: Money::from_cents(-cents) };
            let supply = Supply::of_line(&line, None);
            prop_assert_eq!(supply.total, Money::from_cents(cents));
            let claimed = if cents <= 20_000 || confirmed { cents } else { 0 };
            prop_assert_eq!(purchases_claimed(cents, cents, confirmed), claimed);
        }

        /// A payment's own supply never changes what a larger supply would do to the figures'
        /// footing: whatever the supply total, the postings still sum to zero.
        #[test]
        fn any_supply_still_foots(cents in 1i64..1_000_000, extra in 0i64..1_000_000, confirmed in any::<bool>()) {
            let got = post(cents, "2025-09-01", Some(cents + extra), confirmed);
            prop_assert_eq!(got.iter().map(|(_, c)| c).sum::<i64>(), 0);
        }
    }

    /// docs/domain.md, "Purchases paid in parts": Kōwhai Electrical's deposit and balance.
    #[test]
    fn kowhai_example() {
        // As separate payments, each is $200 or less, so 19.57 + 25.50 = 45.07 is claimed.
        assert_eq!(
            post(15_000, "2026-03-12", None, false),
            [
                ("230".into(), 13_043),
                ("810".into(), 1_957),
                ("600.01".into(), -15_000)
            ]
        );
        assert_eq!(
            post(19_550, "2026-03-19", None, false),
            [
                ("230".into(), 17_000),
                ("810".into(), 2_550),
                ("600.01".into(), -19_550)
            ]
        );
        assert_eq!(purchases_claimed(15_000, 15_000, false), 15_000);
        assert_eq!(purchases_claimed(19_550, 19_550, false), 19_550);

        // As one purchase of 345.50, both payments' GST waits in 615 and the expenses stay put.
        assert_eq!(
            post(15_000, "2026-03-12", Some(34_550), false),
            [
                ("230".into(), 13_043),
                ("615".into(), 1_957),
                ("600.01".into(), -15_000)
            ]
        );
        assert_eq!(
            post(19_550, "2026-03-19", Some(34_550), false),
            [
                ("230".into(), 17_000),
                ("615".into(), 2_550),
                ("600.01".into(), -19_550)
            ]
        );
        assert_eq!(purchases_claimed(15_000, 34_550, false), 0);
        assert_eq!(purchases_claimed(19_550, 34_550, false), 0);

        // The invoice confirms the supply information: the GST moves back to 810.
        assert_eq!(
            post(15_000, "2026-03-12", Some(34_550), true),
            [
                ("230".into(), 13_043),
                ("810".into(), 1_957),
                ("600.01".into(), -15_000)
            ]
        );
        assert_eq!(purchases_claimed(19_550, 34_550, true), 19_550);
    }

    /// The tier is the supply's: a payment over $200 whose supply is its own still waits, and a
    /// part-paid supply (total above the payments) tips a small payment over.
    #[test]
    fn the_threshold_reads_the_supply_total() {
        assert_eq!(post(20_000, "2026-03-12", Some(20_000), false)[1].0, "810");
        assert_eq!(post(20_000, "2026-03-12", Some(20_001), false)[1].0, "615");
    }

    // ---- check_purchase ----------------------------------------------------------------------

    fn pl<'a>(id: &'a str, date: &str, cents: i64) -> PurchaseLine<'a> {
        PurchaseLine {
            id,
            date: d(date),
            amount: Money::from_cents(cents),
        }
    }

    fn none() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn a_valid_purchase_passes() {
        let lines = [
            pl("a", "2026-03-12", -15_000),
            pl("b", "2026-03-19", -19_550),
        ];
        assert!(check_purchase(&lines, Money::from_cents(34_550), &none()).is_empty());
        // Part paid another way: a total above the payments is allowed.
        assert!(check_purchase(&lines, Money::from_cents(50_000), &none()).is_empty());
        // One payment, with a larger total.
        assert!(check_purchase(&lines[..1], Money::from_cents(40_000), &none()).is_empty());
    }

    #[test]
    fn each_rule_rejects() {
        let a = pl("a", "2026-03-12", -15_000);
        let b = pl("b", "2026-03-19", -19_550);
        let total = Money::from_cents(34_550);

        assert_eq!(
            check_purchase(&[], total, &none()),
            [PurchaseError::NoLines]
        );
        assert_eq!(
            check_purchase(&[a.clone(), a.clone()], Money::from_cents(30_000), &none()),
            [PurchaseError::LineRepeated {
                line_id: "a".into()
            }]
        );
        assert_eq!(
            check_purchase(&[a.clone(), pl("c", "2026-03-13", 500)], total, &none()),
            [PurchaseError::NotMoneyOut {
                line_id: "c".into()
            }]
        );
        // A nil line is not money out either.
        assert_eq!(
            check_purchase(&[a.clone(), pl("z", "2026-03-13", 0)], total, &none()),
            [PurchaseError::NotMoneyOut {
                line_id: "z".into()
            }]
        );
        let held: BTreeSet<String> = ["b".to_owned()].into();
        assert_eq!(
            check_purchase(&[a.clone(), b.clone()], total, &held),
            [PurchaseError::InAnotherPurchase {
                line_id: "b".into()
            }]
        );
        assert_eq!(
            check_purchase(&[a.clone(), b.clone()], Money::from_cents(34_549), &none()),
            [PurchaseError::TotalBelowPayments {
                total: Money::from_cents(34_549),
                paid: Money::from_cents(34_550),
            }]
        );
        let far = pl("f", "2027-03-13", -1_000); // 366 days after 12 March 2026
        assert_eq!(
            check_purchase(&[a.clone(), far], Money::from_cents(16_000), &none()),
            [PurchaseError::TooSpread {
                line_id: "f".into()
            }]
        );
        // Exactly 365 days is fine.
        let edge = pl("e", "2027-03-12", -1_000);
        assert!(check_purchase(&[a.clone(), edge], Money::from_cents(16_000), &none()).is_empty());
    }

    #[test]
    fn every_broken_rule_is_returned() {
        let errors = check_purchase(
            &[pl("a", "2026-01-01", 100), pl("b", "2027-06-01", -500)],
            Money::from_cents(100),
            &["a".to_owned()].into(),
        );
        assert_eq!(
            errors,
            [
                PurchaseError::NotMoneyOut {
                    line_id: "a".into()
                },
                PurchaseError::InAnotherPurchase {
                    line_id: "a".into()
                },
                PurchaseError::TotalBelowPayments {
                    total: Money::from_cents(100),
                    paid: Money::from_cents(500),
                },
                PurchaseError::TooSpread {
                    line_id: "b".into()
                },
            ]
        );
    }

    // ---- names, references and words ---------------------------------------------------------

    #[test]
    fn payee_keys() {
        let key = |s: &str| payee_key(s);
        assert_eq!(
            key("AP KOWHAI ELECTRICAL DEP 4471").as_deref(),
            Some("KOWHAI")
        );
        assert_eq!(key("POS KAPAI CAFE WELLINGTON").as_deref(), Some("KAPAI"));
        assert_eq!(key("DD PIHI EQUIPMENT HIRE").as_deref(), Some("PIHI"));
        assert_eq!(
            key("VISA 4835 12/03 NEW WORLD KILBIRNIE").as_deref(),
            Some("WORLD")
        );
        assert_eq!(key("Pos Kōwhai Electrical").as_deref(), Some("KOWHAI"));
        assert_eq!(key("EFTPOS 12 4471"), None);
        assert_eq!(key("AP TO"), None);
    }

    #[test]
    fn references_skip_cards_and_dates() {
        let r = |s: &str| reference_digits(s).into_iter().collect::<Vec<_>>();
        assert_eq!(r("AP KOWHAI ELECTRICAL DEP 4471"), ["4471"]);
        assert_eq!(r("POS SHOP INV#4471"), ["4471"]);
        assert_eq!(r("POS SHOP INV-4471"), ["4471"]);
        assert_eq!(r("POS SHOP H5120"), ["5120"]);
        assert!(r("VISA 4835 SHOP").is_empty());
        assert!(r("CARD 4835-****-1234 SHOP").is_empty());
        assert!(r("SHOP 12/03/2026").is_empty());
        assert!(r("SHOP 20260312").is_empty());
        assert!(r("SHOP 4835-1234-5678").is_empty());
        assert!(r("SHOP 123").is_empty());
    }

    #[test]
    fn instalment_words() {
        for yes in [
            "AP KOWHAI DEP 12",
            "KOWHAI BALANCE",
            "SHOP PART PAYMENT",
            "SHOP FINAL",
            "SHOP INSTALMENT",
            "SHOP 1/2",
            "SHOP 2 OF 3",
            "shop deposit",
        ] {
            assert!(has_instalment_words(yes), "{yes}");
        }
        for no in [
            "POS KAPAI CAFE",
            "SHOP PARTY SUPPLIES",
            "SHOP DEPOT",
            "SHOP 12/03",
            "SHOP 3/2",
            "SHOP 0 OF 3",
            "RENT",
        ] {
            assert!(!has_instalment_words(no), "{no}");
        }
    }

    #[test]
    fn name_evidence() {
        assert!(has_name_evidence(
            "Kōwhai Electrical Ltd",
            "4471",
            "AP KOWHAI ELECTRICAL DEP 4471"
        ));
        // A bank that cuts names short.
        assert!(has_name_evidence(
            "Manuka Hardware Ltd",
            "H-5120",
            "POS MANUKA HARDW"
        ));
        assert!(has_name_evidence(
            "Pihi Equipment Hire Ltd",
            "3301",
            "DD PIHI EQUIPMENT HIRE"
        ));
        // Only the invoice number.
        assert!(has_name_evidence(
            "Wero Cleaning",
            "0900",
            "AP 900 CLEAN 0900"
        ));
        assert!(!has_name_evidence("Ltd", "12", "POS LTD 12"));
        assert!(!has_name_evidence(
            "Pihi Equipment Hire Ltd",
            "3301",
            "POS CORNER DAIRY"
        ));
    }

    // ---- possible_splits ---------------------------------------------------------------------

    /// One owned bank line from `expected.json`'s `bank_lines`.
    struct Row {
        id: String,
        date: NaiveDate,
        amount: Money,
        description: String,
    }

    fn rows() -> Vec<Row> {
        let v: serde_json::Value = serde_json::from_str(EXPECTED).unwrap();
        v["bank_lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| Row {
                id: l["id"].as_str().unwrap().to_owned(),
                date: d(l["date"].as_str().unwrap()),
                amount: Money::from_cents(l["amount"].as_i64().unwrap()),
                description: l["description"].as_str().unwrap().to_owned(),
            })
            .collect()
    }

    fn split_lines<'a>(rows: &'a [Row], coding: Option<&'a Coding>) -> Vec<SplitLine<'a>> {
        rows.iter()
            .map(|r| SplitLine {
                id: &r.id,
                date: r.date,
                amount: r.amount,
                description: &r.description,
                coding,
                excluded: false,
            })
            .collect()
    }

    fn pihi_bills() -> [SplitBill<'static>; 2] {
        let bill = |invoice, date, total| SplitBill {
            supplier_name: "Pihi Equipment Hire Ltd",
            supplier_gst_number: "102030400",
            date: d(date),
            invoice_number: invoice,
            total: Money::from_cents(total),
        };
        [
            bill("3301", "2026-04-14", 14_950),
            bill("3302", "2026-04-15", 7_475),
        ]
    }

    fn flag_ids(flags: &[SplitFlag]) -> Vec<(Vec<&str>, &SplitSign)> {
        flags
            .iter()
            .map(|f| (f.lines.iter().map(String::as_str).collect(), &f.sign))
            .collect()
    }

    #[test]
    fn the_fixture_lines_flag_as_expected() {
        let rows = rows();
        let lines = split_lines(&rows, None);
        let flags = possible_splits(&lines, &none(), &[], &pihi_bills());
        assert_eq!(
            flag_ids(&flags),
            [
                (
                    vec!["bl-kowhai-dep", "bl-kowhai-bal"],
                    &SplitSign::SameReference {
                        digits: "4471".into()
                    }
                ),
                (vec!["bl-shop-1", "bl-shop-2"], &SplitSign::SameDay),
                (vec!["bl-pihi-1", "bl-pihi-2"], &SplitSign::SplitBills),
            ]
        );
        // The weekly café, and the lines over $200, are never in a flag.
        for f in &flags {
            for id in &f.lines {
                assert!(!id.starts_with("bl-cafe"), "{id}");
            }
        }
    }

    #[test]
    fn without_the_bills_the_pihi_payments_carry_no_sign() {
        let rows = rows();
        let lines = split_lines(&rows, None);
        let flags = possible_splits(&lines, &none(), &[], &[]);
        assert_eq!(flags.len(), 2);
        assert!(
            flags
                .iter()
                .all(|f| !f.lines.iter().any(|l| l.starts_with("bl-pihi")))
        );
    }

    fn line<'a>(id: &'a str, date: &str, cents: i64, description: &'a str) -> SplitLine<'a> {
        SplitLine {
            id,
            date: d(date),
            amount: Money::from_cents(-cents),
            description,
            coding: None,
            excluded: false,
        }
    }

    #[test]
    fn each_sign_flags_on_its_own() {
        // Reference only: no instalment words, different days.
        let a = [
            line("a", "2026-03-01", 15_000, "AP ACME JOB 8832"),
            line("b", "2026-04-15", 6_000, "AP ACME JOB 8832"),
        ];
        let f = possible_splits(&a, &none(), &[], &[]);
        assert_eq!(
            f[0].sign,
            SplitSign::SameReference {
                digits: "8832".into()
            }
        );

        // Words only.
        let a = [
            line("a", "2026-03-01", 15_000, "AP ACME DEPOSIT"),
            line("b", "2026-04-15", 6_000, "AP ACME FINAL"),
        ];
        let f = possible_splits(&a, &none(), &[], &[]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].sign, SplitSign::InstalmentWords);

        // Same day only.
        let a = [
            line("a", "2026-03-01", 15_000, "POS ACME"),
            line("b", "2026-03-01", 6_000, "POS ACME"),
        ];
        let f = possible_splits(&a, &none(), &[], &[]);
        assert_eq!(f[0].sign, SplitSign::SameDay);
    }

    #[test]
    fn signs_need_their_window_total_and_payee() {
        // The reference is shared, but the payments are 61 days apart.
        let a = [
            line("a", "2026-01-01", 15_000, "AP ACME JOB 8832"),
            line("b", "2026-03-03", 15_000, "AP ACME JOB 8832"),
        ];
        assert!(possible_splits(&a, &none(), &[], &[]).is_empty());
        // 60 days apart is inside.
        let a = [
            line("a", "2026-01-01", 15_000, "AP ACME JOB 8832"),
            line("b", "2026-03-02", 15_000, "AP ACME JOB 8832"),
        ];
        assert_eq!(possible_splits(&a, &none(), &[], &[]).len(), 1);
        // Together $200 or less isn't enough to matter.
        let a = [
            line("a", "2026-03-01", 10_000, "POS ACME"),
            line("b", "2026-03-01", 10_000, "POS ACME"),
        ];
        assert!(possible_splits(&a, &none(), &[], &[]).is_empty());
        // Different payees on the same day.
        let a = [
            line("a", "2026-03-01", 15_000, "POS ACME"),
            line("b", "2026-03-01", 15_000, "POS ZENITH"),
        ];
        assert!(possible_splits(&a, &none(), &[], &[]).is_empty());
        // A payment over $200 is its own supply already.
        let a = [
            line("a", "2026-03-01", 20_001, "AP ACME DEPOSIT 4471"),
            line("b", "2026-03-02", 5_000, "AP ACME BAL 4471"),
        ];
        assert!(possible_splits(&a, &none(), &[], &[]).is_empty());
    }

    #[test]
    fn lines_that_cannot_matter_are_left_out() {
        let personal = Coding::Out(WithdrawalCoding::Personal);
        let no_gst = Coding::Out(WithdrawalCoding::Expense {
            account: code("230"),
            gst: GstCode::None,
        });
        let standard = repairs();
        let mk = |coding: Option<&'_ Coding>, excluded: bool| {
            let mut a = [
                line("a", "2026-03-12", 15_000, "AP KOWHAI DEP 4471"),
                line("b", "2026-03-19", 19_550, "AP KOWHAI BAL 4471"),
            ];
            a[1].coding = coding;
            a[1].excluded = excluded;
            possible_splits(&a, &none(), &[], &[]).len()
        };
        assert_eq!(mk(None, false), 1);
        assert_eq!(mk(Some(&standard), false), 1);
        assert_eq!(mk(Some(&personal), false), 0);
        assert_eq!(mk(Some(&no_gst), false), 0);
        assert_eq!(mk(None, true), 0);

        // Money in, and a line already in a purchase, never flag.
        let mut a = [
            line("a", "2026-03-12", 15_000, "AP KOWHAI DEP 4471"),
            line("b", "2026-03-19", 19_550, "AP KOWHAI BAL 4471"),
        ];
        let held: BTreeSet<String> = ["b".to_owned()].into();
        assert!(possible_splits(&a, &held, &[], &[]).is_empty());
        a[1].amount = Money::from_cents(19_550);
        assert!(possible_splits(&a, &none(), &[], &[]).is_empty());
    }

    #[test]
    fn an_answered_set_does_not_flag_again() {
        let rows = rows();
        let lines = split_lines(&rows, None);
        let answer = vec![vec!["bl-kowhai-bal".to_owned(), "bl-kowhai-dep".to_owned()]];
        let flags = possible_splits(&lines, &none(), &answer, &pihi_bills());
        let ids = flag_ids(&flags);
        assert_eq!(ids.len(), 2);
        assert!(ids.iter().all(|(l, _)| !l.contains(&"bl-kowhai-dep")));
        // Answered in any order of ids.
        let answer = vec![vec!["bl-shop-2".to_owned(), "bl-shop-1".to_owned()]];
        assert_eq!(
            possible_splits(&lines, &none(), &answer, &pihi_bills()).len(),
            2
        );

        // A new payment makes a different set, which can flag.
        let mut more = rows;
        more.push(Row {
            id: "bl-kowhai-extra".into(),
            date: d("2026-03-20"),
            amount: Money::from_cents(-5_000),
            description: "AP KOWHAI ELECTRICAL 4471".into(),
        });
        let lines = split_lines(&more, None);
        let answer = vec![vec!["bl-kowhai-bal".to_owned(), "bl-kowhai-dep".to_owned()]];
        let flags = possible_splits(&lines, &none(), &answer, &[]);
        assert!(
            flags
                .iter()
                .any(|f| f.lines == ["bl-kowhai-dep", "bl-kowhai-bal", "bl-kowhai-extra"])
        );
    }

    #[test]
    fn a_line_is_in_at_most_one_flag_and_the_strongest_sign_wins() {
        // Same reference, instalment words and the same day all hold for these three.
        let a = [
            line("a", "2026-03-12", 15_000, "AP KOWHAI DEP 4471"),
            line("b", "2026-03-12", 19_550, "AP KOWHAI BAL 4471"),
            line("c", "2026-03-12", 5_000, "AP KOWHAI 4471"),
        ];
        let f = possible_splits(&a, &none(), &[], &[]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].lines, ["a", "b", "c"]);
        assert_eq!(
            f[0].sign,
            SplitSign::SameReference {
                digits: "4471".into()
            }
        );

        // A line leaves its weaker flag when a stronger one took it.
        let a = [
            line("a", "2026-03-12", 15_000, "AP KOWHAI DEP 4471"),
            line("b", "2026-03-13", 19_550, "AP KOWHAI BAL 4471"),
            line("c", "2026-03-13", 9_000, "AP KOWHAI"),
        ];
        let f = possible_splits(&a, &none(), &[], &[]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].lines, ["a", "b"]);
    }

    #[test]
    fn split_bills_need_one_gst_number_and_neighbouring_numbers() {
        let rows = rows();
        let lines = split_lines(&rows, None);
        let base = pihi_bills();
        let with = |bills: &[SplitBill<'_>]| {
            possible_splits(&lines, &none(), &[], bills)
                .iter()
                .any(|f| f.sign == SplitSign::SplitBills)
        };
        assert!(with(&base));

        // Another supplier's GST number: not the same supply.
        let mut other = base.clone();
        other[1].supplier_gst_number = "123456785";
        assert!(!with(&other));
        // Invoice numbers two apart, on different days.
        let mut apart = base.clone();
        apart[1].invoice_number = "3303";
        assert!(!with(&apart));
        // Different days, but the same date links them.
        let mut same_day = base.clone();
        same_day[1].invoice_number = "9000";
        same_day[1].date = base[0].date;
        assert!(with(&same_day));
        // Together $200 or less.
        let mut small = base.clone();
        small[0].total = Money::from_cents(10_000);
        assert!(!with(&small));
        // A bill over $200 is a supply by itself.
        let mut big = base.clone();
        big[0].total = Money::from_cents(20_001);
        assert!(!with(&big));
        // Hyphenated numbers keep their prefix.
        let mut prefixed = base.clone();
        prefixed[0].invoice_number = "INV-3301";
        prefixed[1].invoice_number = "INV-3302";
        assert!(with(&prefixed));
        prefixed[1].invoice_number = "JOB-3302";
        assert!(!with(&prefixed));
    }

    #[test]
    fn a_regular_payment_with_one_instalment_word_flags_only_inside_a_window() {
        // Weekly café, one of which says PART: only the first 60 days flag.
        let a: Vec<SplitLine<'_>> = (0..12)
            .map(|i| {
                let id: &'static str = Box::leak(format!("c{i:02}").into_boxed_str());
                let desc = if i == 1 {
                    "POS KAPAI CAFE PART"
                } else {
                    "POS KAPAI CAFE"
                };
                SplitLine {
                    id,
                    date: d("2026-02-01") + chrono::Days::new(7 * i),
                    amount: Money::from_cents(-8_000),
                    description: desc,
                    coding: None,
                    excluded: false,
                }
            })
            .collect();
        let f = possible_splits(&a, &none(), &[], &[]);
        assert_eq!(f.len(), 1);
        assert!(f[0].lines.len() <= 9, "{:?}", f[0].lines);
    }

    proptest! {
        /// The same lines in any order give the same flags.
        #[test]
        fn the_order_of_the_inputs_does_not_matter(seed in any::<u64>()) {
            let rows = rows();
            let mut lines = split_lines(&rows, None);
            let mut bills = pihi_bills().to_vec();
            let expected = possible_splits(&lines, &none(), &[], &bills);
            // A small deterministic shuffle from the seed.
            let mut s = seed | 1;
            let mut next = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
            for i in (1..lines.len()).rev() {
                let j = usize::try_from(next() % (i as u64 + 1)).unwrap();
                lines.swap(i, j);
            }
            bills.reverse();
            prop_assert_eq!(possible_splits(&lines, &none(), &[], &bills), expected);
        }
    }
}
