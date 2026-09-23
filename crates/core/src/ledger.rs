//! Client-years, journals, trial balances and year-end rollover.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::chart::{AccountCode, AccountType, Chart};
use crate::money::Money;

/// One client's financial year. First and last years may be shorter or longer than 12 months.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(try_from = "ClientYearDates")]
#[ts(export)]
pub struct ClientYear {
    #[ts(type = "string")]
    start: NaiveDate,
    #[ts(type = "string")]
    end: NaiveDate,
}

#[derive(Deserialize)]
struct ClientYearDates {
    start: NaiveDate,
    end: NaiveDate,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("a client-year can't end ({end}) before it starts ({start})")]
pub struct ClientYearError {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

impl ClientYear {
    pub fn new(start: NaiveDate, end: NaiveDate) -> Result<ClientYear, ClientYearError> {
        if end < start {
            return Err(ClientYearError { start, end });
        }
        Ok(ClientYear { start, end })
    }

    pub fn start(&self) -> NaiveDate {
        self.start
    }

    pub fn end(&self) -> NaiveDate {
        self.end
    }

    /// Whether `date` falls in the year, both ends included.
    pub fn contains(&self, date: NaiveDate) -> bool {
        self.start <= date && date <= self.end
    }
}

impl TryFrom<ClientYearDates> for ClientYear {
    type Error = ClientYearError;
    fn try_from(d: ClientYearDates) -> Result<ClientYear, ClientYearError> {
        ClientYear::new(d.start, d.end)
    }
}

/// One line of a journal. Debits are positive and credits negative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JournalLine {
    pub account: AccountCode,
    pub amount: Money,
}

/// A journal's content. Ids, authorship and reversal links belong to the store, not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Journal {
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub narration: String,
    pub lines: Vec<JournalLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum JournalError {
    #[error("a journal needs at least 2 lines")]
    TooFewLines,
    #[error("the journal is out of balance by {difference}")]
    Unbalanced { difference: Money },
    #[error("line {line}: account {account} isn't in the chart")]
    UnknownAccount { line: u32, account: AccountCode },
    #[error("line {line}: account {account} is inactive")]
    InactiveAccount { line: u32, account: AccountCode },
    #[error("the date {date} is outside the year {start} to {end}")]
    OutsideYear {
        #[ts(type = "string")]
        date: NaiveDate,
        #[ts(type = "string")]
        start: NaiveDate,
        #[ts(type = "string")]
        end: NaiveDate,
    },
}

impl Journal {
    /// Checks the journal invariants from CLAUDE.md and returns every problem found, so the UI can
    /// show them all at once. Line numbers start at 1.
    pub fn validate(&self, chart: &Chart, year: &ClientYear) -> Result<(), Vec<JournalError>> {
        let mut errors = Vec::new();
        if self.lines.len() < 2 {
            errors.push(JournalError::TooFewLines);
        }
        let difference: Money = self.lines.iter().map(|l| l.amount).sum();
        if !difference.is_zero() {
            errors.push(JournalError::Unbalanced { difference });
        }
        for (i, line) in self.lines.iter().enumerate() {
            let n = u32::try_from(i + 1).unwrap_or(u32::MAX);
            match chart.get(&line.account) {
                None => errors.push(JournalError::UnknownAccount {
                    line: n,
                    account: line.account.clone(),
                }),
                Some(a) if !a.active => errors.push(JournalError::InactiveAccount {
                    line: n,
                    account: line.account.clone(),
                }),
                Some(_) => {}
            }
        }
        if !year.contains(self.date) {
            errors.push(JournalError::OutsideYear {
                date: self.date,
                start: year.start,
                end: year.end,
            });
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

/// Account balances, keyed and ordered by account code. Zero balances are left out, so two trial
/// balances with the same non-zero balances are equal.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(from = "Vec<TbLine>", into = "Vec<TbLine>")]
#[ts(export, as = "Vec<TbLine>")]
pub struct TrialBalance {
    balances: BTreeMap<AccountCode, Money>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TbLine {
    pub account: AccountCode,
    pub balance: Money,
}

impl TrialBalance {
    /// Adds `amount` to `account`'s balance.
    pub fn post(&mut self, account: &AccountCode, amount: Money) {
        let balance = self.balances.entry(account.clone()).or_default();
        *balance += amount;
        if balance.is_zero() {
            self.balances.remove(account);
        }
    }

    /// The closing trial balance: `opening` plus every journal's lines.
    pub fn from_journals<'a>(
        opening: &TrialBalance,
        journals: impl IntoIterator<Item = &'a Journal>,
    ) -> TrialBalance {
        let mut tb = opening.clone();
        for line in journals.into_iter().flat_map(|j| &j.lines) {
            tb.post(&line.account, line.amount);
        }
        tb
    }

    pub fn balance(&self, account: &AccountCode) -> Money {
        self.balances.get(account).copied().unwrap_or_default()
    }

    /// Non-zero balances in account-code order.
    pub fn iter(&self) -> impl Iterator<Item = (&AccountCode, Money)> {
        self.balances.iter().map(|(code, &m)| (code, m))
    }

    /// The sum of all balances. Zero when the trial balance balances.
    pub fn total(&self) -> Money {
        self.balances.values().sum()
    }

    pub fn is_balanced(&self) -> bool {
        self.total().is_zero()
    }
}

impl From<Vec<TbLine>> for TrialBalance {
    fn from(lines: Vec<TbLine>) -> TrialBalance {
        let mut tb = TrialBalance::default();
        for line in lines {
            tb.post(&line.account, line.balance);
        }
        tb
    }
}

impl From<TrialBalance> for Vec<TbLine> {
    fn from(tb: TrialBalance) -> Vec<TbLine> {
        tb.balances
            .into_iter()
            .map(|(account, balance)| TbLine { account, balance })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RolloverError {
    #[error("the retained earnings account {0} isn't in the chart")]
    RetainedEarningsMissing(AccountCode),
    #[error("the retained earnings account {0} isn't an equity account")]
    RetainedEarningsNotEquity(AccountCode),
    #[error("account {0} has a closing balance but isn't in the chart")]
    UnknownAccount(AccountCode),
}

/// Computes a year's opening balances from the prior year's closing trial balance. Balance-sheet
/// accounts carry forward; income and expense accounts close to `retained_earnings`. The result is
/// computed on demand and never posted.
pub fn rollover(
    prior_closing: &TrialBalance,
    chart: &Chart,
    retained_earnings: &AccountCode,
) -> Result<TrialBalance, RolloverError> {
    match chart.get(retained_earnings) {
        None => {
            return Err(RolloverError::RetainedEarningsMissing(
                retained_earnings.clone(),
            ));
        }
        Some(a) if a.account_type != AccountType::Equity => {
            return Err(RolloverError::RetainedEarningsNotEquity(
                retained_earnings.clone(),
            ));
        }
        Some(_) => {}
    }
    let mut opening = TrialBalance::default();
    for (code, balance) in prior_closing.iter() {
        let account = chart
            .get(code)
            .ok_or_else(|| RolloverError::UnknownAccount(code.clone()))?;
        let target = if account.account_type.is_balance_sheet() {
            code
        } else {
            retained_earnings
        };
        opening.post(target, balance);
    }
    Ok(opening)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::tests::{account, code};
    use proptest::prelude::*;

    fn date(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn year() -> ClientYear {
        ClientYear::new(date("2025-04-01"), date("2026-03-31")).unwrap()
    }

    fn chart() -> Chart {
        let mut inactive = account("610", "Old expense", AccountType::Expense);
        inactive.active = false;
        Chart::new(vec![
            account("200", "Sales", AccountType::Income),
            account("600", "Bank fees", AccountType::Expense),
            inactive,
            account("800", "Bank", AccountType::Asset),
            account("900", "Loan", AccountType::Liability),
            account("960", "Retained earnings", AccountType::Equity),
            account("970", "Share capital", AccountType::Equity),
        ])
        .unwrap()
    }

    fn line(c: &str, cents: i64) -> JournalLine {
        JournalLine {
            account: code(c),
            amount: Money::from_cents(cents),
        }
    }

    fn journal(d: &str, lines: Vec<JournalLine>) -> Journal {
        Journal {
            date: date(d),
            narration: "test".to_owned(),
            lines,
        }
    }

    #[test]
    fn client_year_bounds() {
        let y = year();
        assert!(y.contains(date("2025-04-01")));
        assert!(y.contains(date("2026-03-31")));
        assert!(!y.contains(date("2025-03-31")));
        assert!(!y.contains(date("2026-04-01")));
        assert!(ClientYear::new(date("2025-04-01"), date("2025-04-01")).is_ok());
        assert!(ClientYear::new(date("2025-04-01"), date("2025-03-31")).is_err());
        // A long first year is fine.
        assert!(ClientYear::new(date("2024-11-15"), date("2026-03-31")).is_ok());
        assert!(
            serde_json::from_str::<ClientYear>(r#"{"start":"2025-04-01","end":"2025-03-01"}"#)
                .is_err()
        );
        assert_eq!(
            serde_json::to_string(&y).unwrap(),
            r#"{"start":"2025-04-01","end":"2026-03-31"}"#
        );
    }

    #[test]
    fn accepts_a_valid_journal() {
        let j = journal(
            "2025-06-30",
            vec![line("800", 11_500), line("200", -11_500)],
        );
        assert_eq!(j.validate(&chart(), &year()), Ok(()));
    }

    #[test]
    fn rejects_each_invariant() {
        let err = |j: Journal| j.validate(&chart(), &year()).unwrap_err();

        assert_eq!(
            err(journal("2025-06-30", vec![])),
            vec![JournalError::TooFewLines]
        );
        assert_eq!(
            err(journal("2025-06-30", vec![line("800", 0)])),
            vec![JournalError::TooFewLines]
        );
        assert_eq!(
            err(journal(
                "2025-06-30",
                vec![line("800", 100), line("200", -99)]
            )),
            vec![JournalError::Unbalanced {
                difference: Money::from_cents(1)
            }]
        );
        assert_eq!(
            err(journal(
                "2025-06-30",
                vec![line("800", 100), line("555", -100)]
            )),
            vec![JournalError::UnknownAccount {
                line: 2,
                account: code("555")
            }]
        );
        assert_eq!(
            err(journal(
                "2025-06-30",
                vec![line("610", 100), line("800", -100)]
            )),
            vec![JournalError::InactiveAccount {
                line: 1,
                account: code("610")
            }]
        );
        assert_eq!(
            err(journal(
                "2026-04-01",
                vec![line("800", 100), line("200", -100)]
            )),
            vec![JournalError::OutsideYear {
                date: date("2026-04-01"),
                start: date("2025-04-01"),
                end: date("2026-03-31"),
            }]
        );
    }

    #[test]
    fn reports_every_problem_at_once() {
        let j = journal("2027-01-01", vec![line("999", 5)]);
        assert_eq!(j.validate(&chart(), &year()).unwrap_err().len(), 4);
    }

    #[test]
    fn journal_error_json_carries_a_code() {
        let e = JournalError::UnknownAccount {
            line: 2,
            account: code("555"),
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"code":"unknown_account","line":2,"account":"555"}"#
        );
    }

    #[test]
    fn trial_balance_from_journals() {
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
        let journals = [
            journal(
                "2025-06-30",
                vec![line("800", 11_500), line("200", -11_500)],
            ),
            journal("2025-07-31", vec![line("600", 1_500), line("800", -1_500)]),
        ];
        let tb = TrialBalance::from_journals(&opening, &journals);
        assert_eq!(tb.balance(&code("800")), Money::from_cents(11_000));
        assert_eq!(tb.balance(&code("200")), Money::from_cents(-11_500));
        assert_eq!(tb.balance(&code("600")), Money::from_cents(1_500));
        assert_eq!(tb.balance(&code("900")), Money::ZERO);
        assert!(tb.is_balanced());
        let order: Vec<&str> = tb.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(order, ["200", "600", "800", "970"]);
    }

    #[test]
    fn zero_balances_drop_out() {
        let mut tb = TrialBalance::default();
        tb.post(&code("800"), Money::from_cents(500));
        tb.post(&code("800"), Money::from_cents(-500));
        assert_eq!(tb, TrialBalance::default());
        assert_eq!(serde_json::to_string(&tb).unwrap(), "[]");
    }

    #[test]
    fn rollover_carries_balance_sheet_and_closes_pl_to_retained_earnings() {
        let closing: TrialBalance = vec![
            TbLine {
                account: code("200"),
                balance: Money::from_cents(-11_500),
            },
            TbLine {
                account: code("600"),
                balance: Money::from_cents(1_500),
            },
            TbLine {
                account: code("800"),
                balance: Money::from_cents(20_000),
            },
            TbLine {
                account: code("900"),
                balance: Money::from_cents(-5_000),
            },
            TbLine {
                account: code("960"),
                balance: Money::from_cents(-4_000),
            },
            TbLine {
                account: code("970"),
                balance: Money::from_cents(-1_000),
            },
        ]
        .into();
        let opening = rollover(&closing, &chart(), &code("960")).unwrap();
        let expected: TrialBalance = vec![
            TbLine {
                account: code("800"),
                balance: Money::from_cents(20_000),
            },
            TbLine {
                account: code("900"),
                balance: Money::from_cents(-5_000),
            },
            // -4,000 brought forward plus this year's profit of 10,000.
            TbLine {
                account: code("960"),
                balance: Money::from_cents(-14_000),
            },
            TbLine {
                account: code("970"),
                balance: Money::from_cents(-1_000),
            },
        ]
        .into();
        assert_eq!(opening, expected);
    }

    #[test]
    fn rollover_errors() {
        let tb: TrialBalance = vec![TbLine {
            account: code("555"),
            balance: Money::from_cents(1),
        }]
        .into();
        assert_eq!(
            rollover(&tb, &chart(), &code("960")),
            Err(RolloverError::UnknownAccount(code("555")))
        );
        assert_eq!(
            rollover(&TrialBalance::default(), &chart(), &code("123")),
            Err(RolloverError::RetainedEarningsMissing(code("123")))
        );
        assert_eq!(
            rollover(&TrialBalance::default(), &chart(), &code("800")),
            Err(RolloverError::RetainedEarningsNotEquity(code("800")))
        );
    }

    const CODES: [&str; 7] = ["200", "600", "610", "800", "900", "960", "970"];

    /// A random balanced journal: random amounts on random accounts, plus one line that balances.
    fn arb_journal() -> impl Strategy<Value = Journal> {
        (
            proptest::collection::vec((0..CODES.len(), -10_000_000i64..10_000_000), 1..8),
            0..CODES.len(),
        )
            .prop_map(|(lines, balancing)| {
                let mut lines: Vec<JournalLine> =
                    lines.into_iter().map(|(i, c)| line(CODES[i], c)).collect();
                let total: Money = lines.iter().map(|l| l.amount).sum();
                lines.push(JournalLine {
                    account: code(CODES[balancing]),
                    amount: -total,
                });
                journal("2025-06-30", lines)
            })
    }

    proptest! {
        #[test]
        fn balanced_journals_give_a_balanced_tb(journals in proptest::collection::vec(arb_journal(), 0..20)) {
            let tb = TrialBalance::from_journals(&TrialBalance::default(), &journals);
            prop_assert!(tb.is_balanced());
            let opening = rollover(&tb, &chart(), &code("960")).unwrap();
            prop_assert!(opening.is_balanced());
            for (c, _) in opening.iter() {
                prop_assert!(chart().get(c).unwrap().account_type.is_balance_sheet());
            }
        }

        #[test]
        fn tb_json_round_trips(journals in proptest::collection::vec(arb_journal(), 0..5)) {
            let tb = TrialBalance::from_journals(&TrialBalance::default(), &journals);
            let json = serde_json::to_string(&tb).unwrap();
            prop_assert_eq!(serde_json::from_str::<TrialBalance>(&json).unwrap(), tb);
        }
    }
}
