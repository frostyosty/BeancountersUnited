//! The general ledger listing: every line posted to each account in a year, with a running
//! balance, and the matched reversal pairs that the listing hides by default.
//!
//! A matched pair is a journal and the journal that reverses it, both posted in the year, whose
//! lines cancel account by account. Hiding a pair never changes a balance: the running balance is
//! worked out over every line, so the rows still shown carry the same figures either way.

use std::collections::BTreeMap;

use chrono::NaiveDate;

use crate::chart::AccountCode;
use crate::ledger::{Journal, TrialBalance};
use crate::money::Money;

/// A posted journal as the listing sees it.
#[derive(Debug, Clone, Copy)]
pub struct GlJournal<'a> {
    pub journal: &'a Journal,
    /// The journal this one reverses, as an index into the same slice. `None` when it reverses
    /// nothing, or reverses a journal outside the listing.
    pub reverses: Option<usize>,
}

/// Which journals belong to a matched reversal pair, by index.
///
/// Reversals can chain: a reversal can itself be reversed. Pairs are taken from the newest end of
/// each chain, so in `A ← B ← C` (B reverses A, C reverses B) the pair is B and C, and A, the
/// entry that stands, stays visible. A link whose lines don't cancel the journal it names isn't a
/// match, and pairing carries on from the next link down.
pub fn matched_reversals(journals: &[GlJournal<'_>]) -> Vec<bool> {
    let n = journals.len();
    let target = |i: usize| journals[i].reverses.filter(|&t| t < n && t != i);
    let mut reversed = vec![false; n];
    for i in 0..n {
        if let Some(t) = target(i) {
            reversed[t] = true;
        }
    }
    let mut hidden = vec![false; n];
    let mut seen = vec![false; n];
    // Each chain's tail reverses something and isn't itself reversed.
    for tail in (0..n).filter(|&i| !reversed[i] && target(i).is_some()) {
        let mut cur = tail;
        while !seen[cur] {
            seen[cur] = true;
            let Some(t) = target(cur) else { break };
            if !seen[t] && cancels(journals[cur].journal, journals[t].journal) {
                hidden[cur] = true;
                hidden[t] = true;
                seen[t] = true;
                match target(t) {
                    Some(next) => cur = next,
                    None => break,
                }
            } else {
                cur = t;
            }
        }
    }
    hidden
}

/// Whether two journals' lines add up to nothing on every account.
fn cancels(a: &Journal, b: &Journal) -> bool {
    let mut net: BTreeMap<&AccountCode, Money> = BTreeMap::new();
    for line in a.lines.iter().chain(&b.lines) {
        *net.entry(&line.account).or_default() += line.amount;
    }
    net.values().all(|m| m.is_zero())
}

/// One account's activity in the year.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlAccount {
    pub code: AccountCode,
    /// The balance brought forward (rolled over, never posted).
    pub opening: Money,
    pub closing: Money,
    /// By date, then posting order.
    pub entries: Vec<GlEntry>,
}

/// One journal line on an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlEntry {
    /// The journal, as an index into the slice given to [`gl_listing`].
    pub journal: usize,
    pub date: NaiveDate,
    pub narration: String,
    /// Debit positive, credit negative.
    pub amount: Money,
    /// The account's balance after this line, counting every line, shown or not.
    pub balance: Money,
    /// Part of a matched reversal pair, so hidden by default.
    pub matched_reversal: bool,
}

/// The listing for every account with an opening balance or a line posted in the year, in code
/// order. `journals` is in posting order.
pub fn gl_listing(opening: &TrialBalance, journals: &[GlJournal<'_>]) -> Vec<GlAccount> {
    let hidden = matched_reversals(journals);
    let mut order: Vec<usize> = (0..journals.len()).collect();
    // Stable, so journals on the same day keep their posting order.
    order.sort_by_key(|&i| journals[i].journal.date);

    let mut accounts: BTreeMap<AccountCode, GlAccount> = opening
        .iter()
        .map(|(code, balance)| {
            let account = GlAccount {
                code: code.clone(),
                opening: balance,
                closing: balance,
                entries: Vec::new(),
            };
            (code.clone(), account)
        })
        .collect();
    for i in order {
        let j = journals[i].journal;
        for line in &j.lines {
            let account = accounts
                .entry(line.account.clone())
                .or_insert_with(|| GlAccount {
                    code: line.account.clone(),
                    opening: Money::ZERO,
                    closing: Money::ZERO,
                    entries: Vec::new(),
                });
            account.closing += line.amount;
            account.entries.push(GlEntry {
                journal: i,
                date: j.date,
                narration: j.narration.clone(),
                amount: line.amount,
                balance: account.closing,
                matched_reversal: hidden[i],
            });
        }
    }
    accounts.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::tests::code;
    use crate::ledger::{JournalLine, TbLine};

    fn date(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn journal(d: &str, narration: &str, lines: &[(&str, i64)]) -> Journal {
        Journal {
            date: date(d),
            narration: narration.to_owned(),
            lines: lines
                .iter()
                .map(|&(c, cents)| JournalLine {
                    account: code(c),
                    amount: Money::from_cents(cents),
                })
                .collect(),
        }
    }

    fn reversal_of(j: &Journal, d: &str) -> Journal {
        Journal {
            date: date(d),
            narration: format!("Reversal of: {}", j.narration),
            lines: j
                .lines
                .iter()
                .map(|l| JournalLine {
                    account: l.account.clone(),
                    amount: -l.amount,
                })
                .collect(),
        }
    }

    fn gl<'a>(js: &'a [Journal], reverses: &[Option<usize>]) -> Vec<GlJournal<'a>> {
        js.iter()
            .zip(reverses)
            .map(|(journal, &reverses)| GlJournal { journal, reverses })
            .collect()
    }

    fn sale() -> Journal {
        journal("2025-06-30", "Sale", &[("800", 11_500), ("200", -11_500)])
    }

    #[test]
    fn a_journal_and_its_reversal_pair_up() {
        let a = sale();
        let js = [
            a.clone(),
            journal("2025-07-01", "Fees", &[("600", 500), ("800", -500)]),
            reversal_of(&a, "2025-07-31"),
        ];
        assert_eq!(
            matched_reversals(&gl(&js, &[None, None, Some(0)])),
            [true, false, true]
        );
    }

    #[test]
    fn a_reversal_of_a_reversal_leaves_the_original_showing() {
        let a = sale();
        let b = reversal_of(&a, "2025-07-01");
        let c = reversal_of(&b, "2025-07-02");
        let js = [a, b, c];
        assert_eq!(
            matched_reversals(&gl(&js, &[None, Some(0), Some(1)])),
            [false, true, true]
        );
    }

    #[test]
    fn a_chain_of_four_hides_as_two_pairs() {
        let a = sale();
        let b = reversal_of(&a, "2025-07-01");
        let c = reversal_of(&b, "2025-07-02");
        let d = reversal_of(&c, "2025-07-03");
        let js = [a, b, c, d];
        assert_eq!(
            matched_reversals(&gl(&js, &[None, Some(0), Some(1), Some(2)])),
            [true; 4]
        );
    }

    #[test]
    fn chains_pair_whatever_order_they_were_posted_in() {
        let a = sale();
        let b = reversal_of(&a, "2025-07-01");
        let c = reversal_of(&b, "2025-07-02");
        // Indexes: c = 0, a = 1, b = 2.
        let js = [c, a, b];
        assert_eq!(
            matched_reversals(&gl(&js, &[Some(2), None, Some(1)])),
            [true, false, true]
        );
    }

    #[test]
    fn links_whose_lines_dont_cancel_are_not_matches() {
        let a = sale();
        let partial = journal(
            "2025-07-01",
            "Part reversal",
            &[("200", 5_000), ("800", -5_000)],
        );
        let js = [a, partial];
        assert_eq!(
            matched_reversals(&gl(&js, &[None, Some(0)])),
            [false, false]
        );

        // In A ← B ← C where C doesn't cancel B, pairing moves down to B and A.
        let a = sale();
        let b = reversal_of(&a, "2025-07-01");
        let c = journal("2025-07-02", "Odd", &[("600", 1), ("800", -1)]);
        let js = [a, b, c];
        assert_eq!(
            matched_reversals(&gl(&js, &[None, Some(0), Some(1)])),
            [true, true, false]
        );
    }

    #[test]
    fn links_out_of_range_or_to_itself_are_ignored() {
        let js = [sale(), sale()];
        assert_eq!(
            matched_reversals(&gl(&js, &[Some(0), Some(9)])),
            [false, false]
        );
        // A cycle (impossible in the store) still ends.
        let a = sale();
        let b = reversal_of(&a, "2025-07-01");
        let js = [a, b];
        let hidden = matched_reversals(&gl(&js, &[Some(1), Some(0)]));
        assert_eq!(hidden.len(), 2);
    }

    #[test]
    fn listing_runs_balances_from_the_opening_balance_by_date() {
        let opening: TrialBalance = vec![
            TbLine {
                account: code("800"),
                balance: Money::from_cents(1_000),
            },
            TbLine {
                account: code("970"),
                balance: Money::from_cents(-1_000),
            },
        ]
        .into();
        let a = sale();
        // Posted later but dated earlier, so it lists first.
        let fees = journal("2025-05-01", "Fees", &[("600", 500), ("800", -500)]);
        let rev = reversal_of(&a, "2025-08-01");
        let js = [a, fees, rev];
        let listing = gl_listing(&opening, &gl(&js, &[None, None, Some(0)]));

        let codes: Vec<&str> = listing.iter().map(|a| a.code.as_str()).collect();
        assert_eq!(codes, ["200", "600", "800", "970"]);

        let bank = &listing[2];
        assert_eq!(bank.opening, Money::from_cents(1_000));
        let rows: Vec<(usize, i64, i64, bool)> = bank
            .entries
            .iter()
            .map(|e| {
                (
                    e.journal,
                    e.amount.cents(),
                    e.balance.cents(),
                    e.matched_reversal,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (1, -500, 500, false),
                (0, 11_500, 12_000, true),
                (2, -11_500, 500, true),
            ]
        );
        assert_eq!(bank.closing, Money::from_cents(500));
        // Hiding the pair leaves the shown rows' balances, and the closing balance, alone.
        let shown: Vec<i64> = bank
            .entries
            .iter()
            .filter(|e| !e.matched_reversal)
            .map(|e| e.balance.cents())
            .collect();
        assert_eq!(shown, [500]);

        // Sales nets to nothing but still lists, since lines were posted to it.
        assert_eq!(listing[0].closing, Money::ZERO);
        assert_eq!(listing[0].entries.len(), 2);
        // Share capital has only its opening balance.
        assert!(listing[3].entries.is_empty());
        assert_eq!(listing[3].closing, Money::from_cents(-1_000));
    }

    #[test]
    fn closing_balances_agree_with_the_trial_balance() {
        let a = sale();
        let b = reversal_of(&a, "2025-07-01");
        let c = journal("2025-07-02", "Fees", &[("600", 250), ("800", -250)]);
        let js = [a, b, c];
        let listing = gl_listing(&TrialBalance::default(), &gl(&js, &[None, Some(0), None]));
        let tb = TrialBalance::from_journals(&TrialBalance::default(), &js);
        for account in &listing {
            assert_eq!(account.closing, tb.balance(&account.code));
        }
    }
}
