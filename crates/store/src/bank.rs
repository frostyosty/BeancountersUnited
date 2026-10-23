//! Businesses, bank accounts, uploaded statements, imported lines and gap journals (M10).

use acct_core::bank::HoldingAccounts;
use acct_core::tax::gst::GstFrequency;
use acct_core::{AccountCode, Money};
use chrono::NaiveDate;
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, enum_text, parse, parse_enum};

/// When the owner registered for GST, and how often they file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GstSetting {
    pub registered_from: NaiveDate,
    pub frequency: GstFrequency,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Business {
    pub client_id: String,
    pub start_date: NaiveDate,
    pub gst: Option<GstSetting>,
    pub holding: HoldingAccounts,
    /// Where opening balances go in the year the business started.
    pub capital: AccountCode,
    pub created_seq: i64,
}

#[derive(FromRow)]
struct BusinessRow {
    client_id: String,
    start_date: NaiveDate,
    gst_registered_from: Option<NaiveDate>,
    gst_frequency: Option<String>,
    money_in_account: String,
    money_out_account: String,
    gst_account: String,
    capital_account: String,
    created_seq: i64,
}

pub async fn insert_business(conn: &mut SqliteConnection, b: &Business) -> Result<()> {
    sqlx::query(
        "INSERT INTO businesses
             (client_id, start_date, gst_registered_from, gst_frequency, money_in_account,
              money_out_account, gst_account, capital_account, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&b.client_id)
    .bind(b.start_date)
    .bind(b.gst.map(|g| g.registered_from))
    .bind(b.gst.map(|g| enum_text(&g.frequency)))
    .bind(b.holding.money_in.as_str())
    .bind(b.holding.money_out.as_str())
    .bind(b.holding.gst.as_str())
    .bind(b.capital.as_str())
    .bind(b.created_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn business(conn: &mut SqliteConnection, client_id: &str) -> Result<Option<Business>> {
    let row: Option<BusinessRow> = sqlx::query_as("SELECT * FROM businesses WHERE client_id = ?")
        .bind(client_id)
        .fetch_optional(conn)
        .await?;
    row.map(|r| {
        let gst = match (r.gst_registered_from, r.gst_frequency) {
            (Some(registered_from), Some(f)) => Some(GstSetting {
                registered_from,
                frequency: parse_enum(&f)?,
            }),
            _ => None,
        };
        Ok(Business {
            client_id: r.client_id,
            start_date: r.start_date,
            gst,
            holding: HoldingAccounts {
                money_in: parse(&r.money_in_account)?,
                money_out: parse(&r.money_out_account)?,
                gst: parse(&r.gst_account)?,
            },
            capital: parse(&r.capital_account)?,
            created_seq: r.created_seq,
        })
    })
    .transpose()
}

/// A bank account, or a credit card (M11).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    #[default]
    Bank,
    CreditCard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankAccount {
    pub id: String,
    pub client_id: String,
    /// A bank account is an asset (600.01, ...); a credit card a liability (850.01, ...).
    pub kind: AccountKind,
    pub code: AccountCode,
    pub name: String,
    pub account_number: Option<String>,
    /// The balance on a date, set once.
    pub opening: Option<(NaiveDate, Money)>,
    pub opening_journal_id: Option<String>,
    pub created_seq: i64,
}

#[derive(FromRow)]
struct BankAccountRow {
    id: String,
    client_id: String,
    kind: String,
    account_code: String,
    name: String,
    account_number: Option<String>,
    opening_date: Option<NaiveDate>,
    opening_balance: Option<i64>,
    opening_journal_id: Option<String>,
    created_seq: i64,
}

impl TryFrom<BankAccountRow> for BankAccount {
    type Error = crate::StoreError;
    fn try_from(r: BankAccountRow) -> Result<BankAccount> {
        Ok(BankAccount {
            id: r.id,
            client_id: r.client_id,
            kind: parse_enum(&r.kind)?,
            code: parse(&r.account_code)?,
            name: r.name,
            account_number: r.account_number,
            opening: r.opening_date.zip(r.opening_balance.map(Money::from_cents)),
            opening_journal_id: r.opening_journal_id,
            created_seq: r.created_seq,
        })
    }
}

pub async fn insert_bank_account(conn: &mut SqliteConnection, a: &BankAccount) -> Result<()> {
    sqlx::query(
        "INSERT INTO bank_accounts
             (id, client_id, kind, account_code, name, account_number, opening_date,
              opening_balance, opening_journal_id, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&a.id)
    .bind(&a.client_id)
    .bind(enum_text(&a.kind))
    .bind(a.code.as_str())
    .bind(&a.name)
    .bind(&a.account_number)
    .bind(a.opening.map(|(d, _)| d))
    .bind(a.opening.map(|(_, m)| m.cents()))
    .bind(&a.opening_journal_id)
    .bind(a.created_seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// A business's bank accounts, in the order they were added.
pub async fn bank_accounts(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<BankAccount>> {
    let rows: Vec<BankAccountRow> = sqlx::query_as(
        "SELECT * FROM bank_accounts WHERE client_id = ? ORDER BY created_seq, account_code",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(BankAccount::try_from).collect()
}

/// One imported line.
pub async fn bank_line(conn: &mut SqliteConnection, id: &str) -> Result<Option<BankLine>> {
    let row: Option<BankLineRow> = sqlx::query_as("SELECT * FROM bank_lines WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    Ok(row.map(BankLine::from))
}

pub async fn bank_account(conn: &mut SqliteConnection, id: &str) -> Result<Option<BankAccount>> {
    let row: Option<BankAccountRow> = sqlx::query_as("SELECT * FROM bank_accounts WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(BankAccount::try_from).transpose()
}

pub async fn set_opening(
    conn: &mut SqliteConnection,
    id: &str,
    date: NaiveDate,
    balance: Money,
    journal_id: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "UPDATE bank_accounts SET opening_date = ?, opening_balance = ?, opening_journal_id = ?
         WHERE id = ?",
    )
    .bind(date)
    .bind(balance.cents())
    .bind(journal_id)
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct StoredStatement {
    pub id: String,
    pub bank_account_id: String,
    pub parser: String,
    pub file_name: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub opening_balance: Option<i64>,
    pub closing_balance: Option<i64>,
    pub lines_in_file: i64,
    pub lines_added: i64,
    pub imported_seq: i64,
}

pub async fn insert_statement(conn: &mut SqliteConnection, s: &StoredStatement) -> Result<()> {
    sqlx::query(
        "INSERT INTO statements
             (id, bank_account_id, parser, file_name, start_date, end_date, opening_balance,
              closing_balance, lines_in_file, lines_added, imported_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.bank_account_id)
    .bind(&s.parser)
    .bind(&s.file_name)
    .bind(s.start_date)
    .bind(s.end_date)
    .bind(s.opening_balance)
    .bind(s.closing_balance)
    .bind(s.lines_in_file)
    .bind(s.lines_added)
    .bind(s.imported_seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// A bank account's statements, earliest first.
pub async fn statements(
    conn: &mut SqliteConnection,
    bank_account_id: &str,
) -> Result<Vec<StoredStatement>> {
    Ok(sqlx::query_as(
        "SELECT * FROM statements WHERE bank_account_id = ? ORDER BY start_date, imported_seq",
    )
    .bind(bank_account_id)
    .fetch_all(conn)
    .await?)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankLine {
    pub id: String,
    pub bank_account_id: String,
    pub statement_id: String,
    pub date: NaiveDate,
    pub amount: Money,
    pub description: String,
    pub occurrence: u32,
    pub bank_id: Option<String>,
    pub balance: Option<Money>,
    pub journal_id: String,
    pub possible_duplicate: bool,
}

#[derive(FromRow)]
struct BankLineRow {
    id: String,
    bank_account_id: String,
    statement_id: String,
    date: NaiveDate,
    amount: i64,
    description: String,
    occurrence: i64,
    bank_id: Option<String>,
    balance: Option<i64>,
    journal_id: String,
    possible_duplicate: bool,
}

impl From<BankLineRow> for BankLine {
    fn from(r: BankLineRow) -> BankLine {
        BankLine {
            id: r.id,
            bank_account_id: r.bank_account_id,
            statement_id: r.statement_id,
            date: r.date,
            amount: Money::from_cents(r.amount),
            description: r.description,
            occurrence: u32::try_from(r.occurrence).unwrap_or(0),
            bank_id: r.bank_id,
            balance: r.balance.map(Money::from_cents),
            journal_id: r.journal_id,
            possible_duplicate: r.possible_duplicate,
        }
    }
}

pub async fn insert_bank_line(conn: &mut SqliteConnection, l: &BankLine) -> Result<()> {
    sqlx::query(
        "INSERT INTO bank_lines
             (id, bank_account_id, statement_id, date, amount, description, occurrence, bank_id,
              balance, journal_id, possible_duplicate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&l.id)
    .bind(&l.bank_account_id)
    .bind(&l.statement_id)
    .bind(l.date)
    .bind(l.amount.cents())
    .bind(&l.description)
    .bind(i64::from(l.occurrence))
    .bind(&l.bank_id)
    .bind(l.balance.map(Money::cents))
    .bind(&l.journal_id)
    .bind(l.possible_duplicate)
    .execute(conn)
    .await?;
    Ok(())
}

/// Every imported line of a business, by date then account.
pub async fn bank_lines(conn: &mut SqliteConnection, client_id: &str) -> Result<Vec<BankLine>> {
    let rows: Vec<BankLineRow> = sqlx::query_as(
        "SELECT l.* FROM bank_lines l JOIN bank_accounts a ON a.id = l.bank_account_id
         WHERE a.client_id = ? ORDER BY l.date, a.created_seq, l.id",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(BankLine::from).collect())
}

/// Whether a line with this duplicate key is already imported.
pub async fn line_exists(
    conn: &mut SqliteConnection,
    bank_account_id: &str,
    date: NaiveDate,
    amount: Money,
    description: &str,
    occurrence: u32,
) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM bank_lines WHERE bank_account_id = ? AND date = ? AND amount = ?
         AND description = ? AND occurrence = ?",
    )
    .bind(bank_account_id)
    .bind(date)
    .bind(amount.cents())
    .bind(description)
    .bind(i64::from(occurrence))
    .fetch_optional(conn)
    .await?;
    Ok(row.is_some())
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct GapJournal {
    pub journal_id: String,
    pub bank_account_id: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
}

pub async fn insert_gap_journal(conn: &mut SqliteConnection, g: &GapJournal) -> Result<()> {
    sqlx::query(
        "INSERT INTO gap_journals (journal_id, bank_account_id, start_date, end_date)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&g.journal_id)
    .bind(&g.bank_account_id)
    .bind(g.start_date)
    .bind(g.end_date)
    .execute(conn)
    .await?;
    Ok(())
}

/// A bank account's gap journals that haven't been reversed.
pub async fn live_gap_journals(
    conn: &mut SqliteConnection,
    bank_account_id: &str,
) -> Result<Vec<GapJournal>> {
    Ok(sqlx::query_as(
        "SELECT g.* FROM gap_journals g
         WHERE g.bank_account_id = ?
           AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_journal_id = g.journal_id)
         ORDER BY g.start_date",
    )
    .bind(bank_account_id)
    .fetch_all(conn)
    .await?)
}
