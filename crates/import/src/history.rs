//! The source-neutral shape every history importer (Xero, MYOB) produces.
//!
//! Each parser reads one export file and returns a [`HistoryImport`]: where it came from and
//! which kind of file it was. Nothing here knows our chart: account codes are kept verbatim as
//! the source wrote them (MYOB's `1-1100` isn't a valid [`acct_core::AccountCode`]), and the
//! server maps them onto the client's chart with a preview. `docs/domain.md`, "Importing from
//! Xero and MYOB", describes the files.
//!
//! Amounts are signed debit positive, credit negative, like the rest of the ledger.

use std::collections::BTreeMap;

use acct_core::Money;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// The product an export came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistorySource {
    Xero,
    MyobAccountRight,
    MyobBusiness,
}

/// The coarse account type every source's types collapse onto. The source's own type is kept
/// beside it, in [`HistoryAccount::source_type`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceAccountType {
    Asset,
    Liability,
    Equity,
    Income,
    CostOfSales,
    Expense,
    OtherIncome,
    OtherExpense,
}

impl SourceAccountType {
    /// Whether the account belongs on the balance sheet (and so has an opening balance).
    pub fn is_balance_sheet(self) -> bool {
        matches!(self, Self::Asset | Self::Liability | Self::Equity)
    }
}

/// One account from a chart of accounts export. `row` is the file's line number, for messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryAccount {
    pub row: u32,
    /// The source's code, verbatim.
    pub code: String,
    pub name: String,
    pub account_type: SourceAccountType,
    /// The type as the file wrote it, such as Xero's `Current Asset`.
    pub source_type: String,
    /// The default tax code as the file wrote it, such as Xero's `15% GST on Income`.
    pub tax_code: Option<String>,
    /// A heading account that can't be posted to (MYOB has them; Xero doesn't).
    pub is_header: bool,
    pub active: bool,
}

/// One account's balance. Debit positive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryTbRow {
    pub row: u32,
    pub code: String,
    pub name: String,
    pub balance: Money,
}

/// A trial balance export: the balances at one date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryTb {
    /// The balance date, where the file states it.
    pub as_at: Option<NaiveDate>,
    pub rows: Vec<HistoryTbRow>,
}

/// One posting from a general ledger detail export. Debit positive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryGlLine {
    pub row: u32,
    pub code: String,
    pub account_name: String,
    pub date: NaiveDate,
    pub reference: String,
    pub description: String,
    /// The kind of transaction, as the file wrote it, such as `Spend Money`.
    pub source: String,
    pub amount: Money,
}

/// A general ledger detail export for a period: each account's opening balance and the
/// postings after it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryGl {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    /// Opening balances at `from`, debit positive. Accounts with a nil opening may be left out.
    pub openings: Vec<HistoryTbRow>,
    pub lines: Vec<HistoryGlLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactKind {
    Customer,
    Supplier,
    Both,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryContact {
    pub row: u32,
    pub name: String,
    pub kind: ContactKind,
    pub gst_number: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
}

/// What a file turned out to be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum HistoryFile {
    Chart(Vec<HistoryAccount>),
    Tb(HistoryTb),
    Gl(HistoryGl),
    Contacts(Vec<HistoryContact>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryImport {
    pub source: HistorySource,
    pub file: HistoryFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum HistoryError {
    /// The file couldn't be read as text or CSV at all.
    Unreadable { message: String },
    /// The file isn't an export we recognise. `header` is the first row we looked at.
    UnknownFormat { header: Vec<String> },
    /// A row we couldn't read: which column, what it held, and why.
    BadRow {
        row: u32,
        column: String,
        value: String,
        reason: String,
    },
    /// The TB's rows don't sum to zero.
    Unbalanced { difference: Money },
    Empty,
}

/// An account whose TB balance isn't its GL opening plus its GL postings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlTbDifference {
    pub code: String,
    pub tb: Money,
    /// Opening balance plus the sum of the account's lines.
    pub gl: Money,
}

/// Checks a GL detail export against the TB at the end of its period. Codes are compared
/// verbatim. Returns every account that disagrees, in code order; empty when they agree.
pub fn gl_differences(gl: &HistoryGl, tb: &HistoryTb) -> Vec<GlTbDifference> {
    let mut sums: BTreeMap<&str, (Money, Money)> = BTreeMap::new();
    for row in &tb.rows {
        sums.entry(&row.code).or_default().0 += row.balance;
    }
    for row in &gl.openings {
        sums.entry(&row.code).or_default().1 += row.balance;
    }
    for line in &gl.lines {
        sums.entry(&line.code).or_default().1 += line.amount;
    }
    sums.into_iter()
        .filter(|(_, (tb, gl))| tb != gl)
        .map(|(code, (tb, gl))| GlTbDifference {
            code: code.to_owned(),
            tb,
            gl,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tb_row(code: &str, cents: i64) -> HistoryTbRow {
        HistoryTbRow {
            row: 0,
            code: code.into(),
            name: String::new(),
            balance: Money::from_cents(cents),
        }
    }

    fn line(code: &str, cents: i64) -> HistoryGlLine {
        HistoryGlLine {
            row: 0,
            code: code.into(),
            account_name: String::new(),
            date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            reference: String::new(),
            description: String::new(),
            source: String::new(),
            amount: Money::from_cents(cents),
        }
    }

    #[test]
    fn gl_agrees_with_tb_when_openings_plus_lines_match() {
        let tb = HistoryTb {
            as_at: None,
            rows: vec![tb_row("090", 1_500), tb_row("200", -500), tb_row("970", -1_000)],
        };
        let mut gl = HistoryGl {
            from: None,
            to: None,
            openings: vec![tb_row("090", 1_000), tb_row("970", -1_000)],
            lines: vec![line("090", 500), line("200", -500)],
        };
        assert_eq!(gl_differences(&gl, &tb), []);

        gl.lines.pop();
        gl.lines.push(line("260", -500));
        assert_eq!(
            gl_differences(&gl, &tb),
            [
                GlTbDifference {
                    code: "200".into(),
                    tb: Money::from_cents(-500),
                    gl: Money::ZERO
                },
                GlTbDifference {
                    code: "260".into(),
                    tb: Money::ZERO,
                    gl: Money::from_cents(-500)
                },
            ]
        );
    }
}
