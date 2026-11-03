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
    /// Where the file states it (M18), for showing the owner the bank's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<SourceSpan>,
}

/// Where a figure sits in the file: its 1-based line, and the byte range within that line
/// (`start` inclusive, `end` exclusive) of the text as [`decode`] gives it.
pub use acct_core::reconcile::SourceSpan;

/// A statement file's text exactly as the parsers read it, so a [`SourceSpan`] indexes into it.
pub fn decode(bytes: &[u8]) -> String {
    text::decode(bytes)
}

/// The copy of an uploaded file we keep (M18). A bank statement is kept as it arrived. A card
/// statement has any full card number in it masked to the last four digits, as everything we
/// read from it already is, so the server never stores a full card number. Masking keeps the
/// length, so the statement's spans still hold.
pub fn kept_copy(bytes: &[u8], statement: &Statement) -> Vec<u8> {
    let last4 = match (statement.kind, statement.account.as_deref()) {
        (StatementKind::CreditCard, Some(card)) => card.rsplit('-').next().unwrap_or(card),
        _ => return bytes.to_vec(),
    };
    if last4.len() == 4 && last4.bytes().all(|b| b.is_ascii_digit()) {
        text::mask_card_numbers(bytes, last4)
    } else {
        bytes.to_vec()
    }
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
    /// Where the file states `balance` (M18).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_span: Option<SourceSpan>,
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
    /// A QIF section other than `!Type:Bank` or `!Type:CCard`, such as `!Type:Invst`, or an OFX
    /// message set other than bank, card and sign-on, such as `INVSTMTMSGSRSV1`.
    UnsupportedSection {
        row: u32,
        section: String,
    },
    /// The file stops part-way, as a download that was cut off does: an OFX file that ends
    /// before closing its root, or inside a transaction. Nothing from it is used, because its
    /// last line may be half-read.
    Truncated {
        /// The file's last non-blank line, where it stops.
        row: u32,
        /// The row where the last fully read transaction starts, if any was.
        last_complete_row: Option<u32>,
        /// That transaction's date, where it had a readable one.
        last_complete_date: Option<NaiveDate>,
    },
    /// The bank sent an error instead of a statement: an OFX `STATUS` whose `CODE` isn't 0 or whose
    /// `SEVERITY` is `ERROR`, such as a failed sign-on. `message` is the bank's own words.
    BankError {
        /// Where the `STATUS` starts.
        row: u32,
        /// The bank's status code, as written.
        bank_code: String,
        message: Option<String>,
    },
    /// The file holds no bank or credit card statement, and nothing else we can name.
    NoStatement,
}

/// What a section we don't read holds, in words.
fn describe_section(section: &str) -> String {
    if section.to_ascii_uppercase().contains("INV") {
        "an investment statement".to_owned()
    } else {
        format!("a \"{section}\" section")
    }
}

/// The problem in plain words for the owner, starting "Row N:" when it's about one row.
impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Problem::Unreadable {
                row: Some(row),
                message,
            } => write!(
                f,
                "Row {row}: we couldn't split this row into columns ({message})."
            ),
            Problem::Unreadable { row: None, message } => {
                write!(f, "We couldn't split this file into columns ({message}).")
            }
            Problem::BadDate { row, value } => {
                write!(f, "Row {row}: \"{value}\" isn't a date we can read.")
            }
            Problem::BadAmount {
                row,
                value,
                message,
            } => write!(
                f,
                "Row {row}: \"{value}\" isn't an amount we can read ({message})."
            ),
            Problem::MonthFirstDates { row, value } => write!(
                f,
                "Row {row}: \"{value}\" only makes sense with the month first. Export the file \
                 with day-first dates (DD/MM/YYYY) and upload it again."
            ),
            Problem::MissingField { row, field } => {
                write!(f, "Row {row}: this line has no {field}.")
            }
            Problem::DebitAndCredit { row } => write!(
                f,
                "Row {row}: this line has an amount in both Debit and Credit, or in neither."
            ),
            Problem::Missing { field } => {
                write!(f, "The file doesn't have the {field} we need.")
            }
            Problem::SeveralAccounts { row, account } => write!(
                f,
                "Row {row}: this line is for account {account}, but the file started with a \
                 different one. Upload one account per file."
            ),
            Problem::SeveralStatements => f.write_str(
                "This file holds more than one statement. Download each account on its own and \
                 upload them one at a time.",
            ),
            Problem::ForeignCurrency { currency } => write!(
                f,
                "This statement is in {currency}. We only read New Zealand dollar (NZD) accounts."
            ),
            Problem::UnsupportedSection { row, section } => write!(
                f,
                "Row {row}: this file holds {}, not a bank or credit card statement. We only \
                 read bank and credit card statements.",
                describe_section(section)
            ),
            Problem::Truncated {
                row,
                last_complete_row,
                last_complete_date,
            } => {
                write!(
                    f,
                    "The file stops part-way, at row {row}, so the download looks cut off."
                )?;
                match (last_complete_row, last_complete_date) {
                    (Some(r), Some(d)) => write!(
                        f,
                        " The last whole transaction is on {} (row {r}).",
                        d.format("%-d %B %Y")
                    )?,
                    (Some(r), None) => write!(f, " The last whole transaction starts at row {r}.")?,
                    (None, _) => f.write_str(" It has no whole transactions.")?,
                }
                f.write_str(
                    " We haven't used any of it. Download it again and upload the new file.",
                )
            }
            Problem::BankError {
                row,
                bank_code: code,
                message,
            } => {
                f.write_str("Your bank sent an error instead of a statement")?;
                match message {
                    Some(m) => write!(f, ": '{m}' (code {code}, row {row}).")?,
                    None => write!(f, " (code {code}, row {row}).")?,
                }
                f.write_str(" Try downloading it again.")
            }
            Problem::NoStatement => f.write_str(
                "This file has no bank or credit card statement in it. Try downloading it again, \
                 choosing the account and the dates.",
            ),
        }
    }
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
            StatementError::Invalid { parser, .. } => {
                let label = PARSERS
                    .iter()
                    .find(|p| p.info.id == parser)
                    .map_or(parser.as_str(), |p| p.info.label);
                write!(f, "We read this file as {label}, but can't use it:")
            }
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
            balance_span: None,
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
    fn problems_read_as_plain_words_with_their_row() {
        let bank = Problem::BankError {
            row: 14,
            bank_code: "15500".to_owned(),
            message: Some("Signon invalid".to_owned()),
        };
        assert_eq!(
            bank.to_string(),
            "Your bank sent an error instead of a statement: 'Signon invalid' (code 15500, row 14). \
             Try downloading it again."
        );
        let bare = Problem::BankError {
            row: 3,
            bank_code: "2000".to_owned(),
            message: None,
        };
        assert_eq!(
            bare.to_string(),
            "Your bank sent an error instead of a statement (code 2000, row 3). Try downloading it again."
        );
        assert_eq!(
            Problem::UnsupportedSection {
                row: 12,
                section: "INVSTMTMSGSRSV1".to_owned()
            }
            .to_string(),
            "Row 12: this file holds an investment statement, not a bank or credit card statement. \
             We only read bank and credit card statements."
        );
        assert!(
            Problem::UnsupportedSection {
                row: 1,
                section: "!Type:Cat".to_owned()
            }
            .to_string()
            .contains("a \"!Type:Cat\" section")
        );
        assert_eq!(
            Problem::NoStatement.to_string(),
            "This file has no bank or credit card statement in it. Try downloading it again, \
             choosing the account and the dates."
        );
        assert_eq!(
            Problem::Truncated {
                row: 50,
                last_complete_row: Some(40),
                last_complete_date: Some("2025-08-05".parse().unwrap()),
            }
            .to_string(),
            "The file stops part-way, at row 50, so the download looks cut off. The last whole \
             transaction is on 5 August 2025 (row 40). We haven't used any of it. Download it again \
             and upload the new file."
        );
        assert_eq!(
            Problem::BadDate {
                row: 7,
                value: "20251301".to_owned()
            }
            .to_string(),
            "Row 7: \"20251301\" isn't a date we can read."
        );
    }

    /// Decided in M17 (docs/domain.md, "Bank statement formats"): every parser keeps a line with
    /// no text, with an empty description. Nothing is made up; the web app shows "(no description)".
    #[test]
    fn a_line_with_no_text_is_kept_with_an_empty_description() {
        let files: [&[u8]; 4] = [
            b"!Type:Bank\nD02/08/2025\nT-5.00\n^\n",
            b"Kowhai Co-operative Bank - Account statement\n\
              Account number,99-5501-0000456-00\n\
              Statement period,01/08/2025,31/08/2025\n\
              Opening balance,10.00\nClosing balance,5.00\n\n\
              Date,Description,Debit,Credit,Balance\n\
              02/08/2025,,5.00,,5.00\nEnd of statement\n",
            b"Account,Posted,Type,Payee,Particulars,Reference,Amount\n\
              99-7702-0000789-00,2025-08-29,INT,,,,1.00\n",
            b"Pohutukawa Card Services - Card statement\n\
              Card number,XXXX XXXX XXXX 8802\n\
              Statement period,15/08/2025,14/09/2025\n\
              Opening balance,10.00\nClosing balance,15.00\n\n\
              Processed,Transaction date,Details,Amount\n\
              16/08/2025,15/08/2025,,5.00\nEnd of statement\n",
        ];
        let mut parsers = Vec::new();
        for file in files {
            let s = read_statement(file).unwrap_or_else(|e| panic!("{e:?}"));
            assert_eq!(s.lines.len(), 1, "{}", s.parser);
            assert_eq!(s.lines[0].description, "", "{}", s.parser);
            parsers.push(s.parser);
        }
        assert_eq!(
            parsers,
            [
                "qif-bank-1",
                "kowhai-csv-1",
                "rimu-csv-1",
                "pohutukawa-card-csv-1"
            ]
        );
    }

    #[test]
    fn an_invalid_file_names_its_format_in_words() {
        let err = StatementError::Invalid {
            parser: "ofx-sgml-1".to_owned(),
            problems: vec![Problem::NoStatement],
        };
        assert_eq!(
            err.to_string(),
            "We read this file as OFX 1.x (SGML), but can't use it:"
        );
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
                span: None,
            }),
            lines: vec![line("2025-08-02", 100, "X")],
        };
        assert_eq!(s.balance_check(), BalanceCheck::Skipped);
        s.opening = Some(Balance {
            date: "2025-08-01".parse().unwrap(),
            amount: Money::ZERO,
            span: None,
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
