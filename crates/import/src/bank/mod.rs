//! Bank and NZD credit card statement files: OFX, QIF and one versioned parser per CSV layout.
//!
//! The rules are in `docs/domain.md` under "Bank statement formats". [`read_statement`] takes the
//! file's bytes, picks the parser by inspecting them, and returns one [`Statement`]: whether it's
//! a bank account or a credit card, the account or masked card number, the lines, and the
//! balances the file states.
//!
//! Every amount and balance is signed from the account's own point of view, for cards too:
//! positive is money in. A card purchase, fee or interest charge is negative; a payment to the
//! card or a refund is positive; and a balance owed on the card is negative. Nothing here knows the client, the chart
//! or today's date; the server checks the lines against those.
//!
//! Duplicate detection keys on account, posting date, amount, normalised description and an
//! occurrence count within that key ([`duplicate_keys`]), so two identical purchases on the same
//! day both survive while an overlapping statement adds nothing.

#[cfg(test)]
mod card_fixtures;
mod kowhai;
mod ofx;
mod pohutukawa;
mod qif;
mod rimu;
mod text;

use std::collections::BTreeMap;
use std::fmt;

use acct_core::Money;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

pub use text::{find_card, normalise_account, normalise_card, normalise_description};

/// A parser we have: its id (which includes the version), the layout family and version, and
/// how the owner would recognise the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ParserInfo {
    /// Family and version together, such as `kowhai-csv-1`. Stored with each import.
    pub id: &'static str,
    pub family: &'static str,
    pub version: u32,
    pub label: &'static str,
}

/// A parser: what it's called, how it recognises its files, and how it reads them.
struct Parser {
    info: ParserInfo,
    detect: fn(&str) -> bool,
    parse: fn(&str) -> Result<Statement, Vec<Problem>>,
}

/// Every parser, in the order they're tried. When a bank changes its layout, add a version and
/// keep the old one, so old files still read.
const PARSERS: &[Parser] = &[
    Parser {
        info: ofx::XML,
        detect: ofx::detect_xml,
        parse: ofx::parse,
    },
    Parser {
        info: ofx::SGML,
        detect: ofx::detect_sgml,
        parse: ofx::parse,
    },
    Parser {
        info: qif::CCARD,
        detect: qif::detect_ccard,
        parse: qif::parse,
    },
    Parser {
        info: qif::BANK,
        detect: qif::detect,
        parse: qif::parse,
    },
    Parser {
        info: kowhai::V1,
        detect: kowhai::detect,
        parse: kowhai::parse,
    },
    Parser {
        info: rimu::V1,
        detect: rimu::detect,
        parse: rimu::parse,
    },
    Parser {
        info: pohutukawa::V1,
        detect: pohutukawa::detect,
        parse: pohutukawa::parse,
    },
];

/// The formats we read, in the order they're tried.
pub fn formats() -> Vec<ParserInfo> {
    PARSERS.iter().map(|p| p.info).collect()
}

/// A balance the file states. An opening balance is the balance at the start of `date`, before
/// any line dated that day; a closing balance is the balance at the end of `date`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Balance {
    pub date: NaiveDate,
    pub amount: Money,
}

/// One transaction from the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementLine {
    /// The file's line number (1-based) where the transaction starts, for messages.
    pub row: u32,
    /// The bank's posting date.
    pub date: NaiveDate,
    /// Signed from the account's point of view: positive is money in. On a card, a purchase is
    /// negative and a payment to the card is positive, whatever sign the file used.
    pub amount: Money,
    /// The text fields joined in the parser's order, uppercased, spaces collapsed, ends trimmed.
    pub description: String,
    /// The bank's own id for the line (OFX `FITID`), where the file has one.
    pub bank_id: Option<String>,
    /// The running balance after this line, where the file has one. Signed like `amount`, so a
    /// balance owed on a card is negative.
    pub balance: Option<Money>,
}

/// What kind of account a statement is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    Bank,
    /// An NZD credit card. Its balance is a liability, so it's normally negative.
    CreditCard,
}

/// What one file holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Statement {
    /// The parser's id, such as `kowhai-csv-1`.
    pub parser: String,
    pub kind: StatementKind,
    /// For a bank account, the account number in `BB-bbbb-AAAAAAA-SS` form where it's a NZ
    /// account number (see [`normalise_account`]). For a card, the masked card number
    /// `XXXX-XXXX-XXXX-1234` (see [`normalise_card`]); a full card number is never kept. `None`
    /// only for a QIF file that doesn't name it; the owner then says which account the file is
    /// for.
    pub account: Option<String>,
    /// The first and last days the file says it covers, where it says so.
    pub period_start: Option<NaiveDate>,
    pub period_end: Option<NaiveDate>,
    pub opening: Option<Balance>,
    pub closing: Option<Balance>,
    /// In the file's order.
    pub lines: Vec<StatementLine>,
}

/// Whether the file's own balances agree with its lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum BalanceCheck {
    Passes,
    /// `row` is the line whose running balance disagrees, or `None` for the closing balance.
    Fails {
        row: Option<u32>,
        expected: Money,
        stated: Money,
    },
    /// The file lacks an opening balance, or has neither a closing balance nor running balances.
    Skipped,
}

impl Statement {
    /// Opening balance + lines = each running balance and the closing balance, where the file
    /// gives both ends. Files without them skip the check rather than fail it.
    pub fn balance_check(&self) -> BalanceCheck {
        let Some(opening) = self.opening else {
            return BalanceCheck::Skipped;
        };
        let has_running = self.lines.iter().any(|l| l.balance.is_some());
        if self.closing.is_none() && !has_running {
            return BalanceCheck::Skipped;
        }
        let mut running = opening.amount;
        for line in &self.lines {
            running += line.amount;
            if let Some(stated) = line.balance
                && stated != running
            {
                return BalanceCheck::Fails {
                    row: Some(line.row),
                    expected: running,
                    stated,
                };
            }
        }
        match self.closing {
            Some(closing) if closing.amount != running => BalanceCheck::Fails {
                row: None,
                expected: running,
                stated: closing.amount,
            },
            _ => BalanceCheck::Passes,
        }
    }
}

/// The duplicate key for one line: account, posting date, amount, normalised description, and
/// which occurrence of that combination this is within its file (1 for the first).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct DuplicateKey {
    pub account: String,
    pub date: NaiveDate,
    pub amount: Money,
    pub description: String,
    pub occurrence: u32,
}

/// One key per line, in the lines' order. `account` is the bank account the file is for, so
/// files that don't name it (some QIF) still key the same way as the others.
///
/// A line is already imported when a stored line has the same key. Two identical purchases on
/// one day get occurrences 1 and 2, so both survive; a later file that holds the same two gets
/// the same keys, so neither is added again.
pub fn duplicate_keys(account: &str, lines: &[StatementLine]) -> Vec<DuplicateKey> {
    let account = normalise_account(account);
    let mut seen: BTreeMap<(NaiveDate, Money, &str), u32> = BTreeMap::new();
    lines
        .iter()
        .map(|line| {
            let count = seen
                .entry((line.date, line.amount, line.description.as_str()))
                .or_insert(0);
            *count += 1;
            DuplicateKey {
                account: account.clone(),
                date: line.date,
                amount: line.amount,
                description: line.description.clone(),
                occurrence: *count,
            }
        })
        .collect()
}

/// Something wrong in a file a parser recognised. `row` is the file's 1-based line number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Problem {
    /// The CSV couldn't be split into fields.
    Unreadable {
        row: Option<u32>,
        message: String,
    },
    BadDate {
        row: u32,
        value: String,
    },
    BadAmount {
        row: u32,
        value: String,
        message: String,
    },
    /// A day-first date that only makes sense month first, such as 08/29/2025. The whole file is
    /// refused rather than guessed at.
    MonthFirstDates {
        row: u32,
        value: String,
    },
    MissingField {
        row: u32,
        field: String,
    },
    /// A layout-A row with an amount in both debit and credit, or in neither.
    DebitAndCredit {
        row: u32,
    },
    /// A field the layout needs, such as the account number, isn't in the file.
    Missing {
        field: String,
    },
    /// A row whose account differs from the file's first account.
    SeveralAccounts {
        row: u32,
        account: String,
    },
    /// The file holds more than one statement (several accounts, or a QIF with several sections).
    SeveralStatements,
    /// Only NZD accounts are read; multi-currency is out of scope.
    ForeignCurrency {
        currency: String,
    },
    /// A QIF section other than `!Type:Bank` or `!Type:CCard`, such as `!Type:Invst`.
    UnsupportedSection {
        row: u32,
        section: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum StatementError {
    /// "We can't read this file": no parser recognised it. `formats` lists what we read.
    NotRecognised { formats: Vec<String> },
    /// A parser recognised the file but found problems. Nothing from it is used.
    Invalid {
        parser: String,
        problems: Vec<Problem>,
    },
}

impl fmt::Display for StatementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StatementError::NotRecognised { formats } => write!(
                f,
                "We can't read this file. We read: {}. Most banks can export OFX \
                 (sometimes called Money or Microsoft Money format) from internet banking.",
                formats.join("; ")
            ),
            StatementError::Invalid { parser, problems } => write!(
                f,
                "This looks like a {parser} file, but {} problem(s) stop us reading it",
                problems.len()
            ),
        }
    }
}

impl std::error::Error for StatementError {}

/// Reads a statement file, picking the parser by inspecting it. Text that isn't UTF-8 is read
/// as Windows-1252, which is what NZ bank exports use otherwise.
pub fn read_statement(bytes: &[u8]) -> Result<Statement, StatementError> {
    let text = text::decode(bytes);
    let parser = PARSERS.iter().find(|p| (p.detect)(&text)).ok_or_else(|| {
        StatementError::NotRecognised {
            formats: PARSERS.iter().map(|p| p.info.label.to_owned()).collect(),
        }
    })?;
    match (parser.parse)(&text) {
        Ok(mut statement) => {
            parser.info.id.clone_into(&mut statement.parser);
            Ok(statement)
        }
        Err(problems) => Err(StatementError::Invalid {
            parser: parser.info.id.to_owned(),
            problems,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(date: &str, cents: i64, description: &str) -> StatementLine {
        StatementLine {
            row: 1,
            date: date.parse().unwrap(),
            amount: Money::from_cents(cents),
            description: description.to_owned(),
            bank_id: None,
            balance: None,
        }
    }

    #[test]
    fn identical_lines_get_increasing_occurrences() {
        let lines = [
            line("2025-08-29", -650, "PIKORUA CAFE"),
            line("2025-08-29", -650, "PIKORUA CAFE"),
            line("2025-08-29", -650, "OTHER"),
        ];
        let keys = duplicate_keys("99-1001-0000123-00", &lines);
        let occ: Vec<u32> = keys.iter().map(|k| k.occurrence).collect();
        assert_eq!(occ, [1, 2, 1]);
    }

    #[test]
    fn unrecognised_files_list_the_formats() {
        let err = read_statement(b"hello,world\n1,2\n").unwrap_err();
        let StatementError::NotRecognised { formats } = &err else {
            panic!("{err:?}");
        };
        assert_eq!(formats.len(), PARSERS.len());
        assert!(err.to_string().starts_with("We can't read this file"));
    }

    #[test]
    fn parser_ids_are_family_dash_version() {
        for p in formats() {
            assert_eq!(p.id, format!("{}-{}", p.family, p.version));
        }
    }

    #[test]
    fn balance_check_skips_without_both_ends() {
        let mut s = Statement {
            parser: String::new(),
            kind: StatementKind::Bank,
            account: None,
            period_start: None,
            period_end: None,
            opening: None,
            closing: Some(Balance {
                date: "2025-08-31".parse().unwrap(),
                amount: Money::from_cents(100),
            }),
            lines: vec![line("2025-08-02", 100, "X")],
        };
        assert_eq!(s.balance_check(), BalanceCheck::Skipped);
        s.opening = Some(Balance {
            date: "2025-08-01".parse().unwrap(),
            amount: Money::ZERO,
        });
        assert_eq!(s.balance_check(), BalanceCheck::Passes);
        s.lines[0].balance = Some(Money::from_cents(99));
        assert_eq!(
            s.balance_check(),
            BalanceCheck::Fails {
                row: Some(1),
                expected: Money::from_cents(100),
                stated: Money::from_cents(99)
            }
        );
    }
}
