//! Businesses, bank accounts, uploaded statements, imported lines and gap journals (M10).

use acct_core::bank::HoldingAccounts;
use acct_core::reconcile::{BalanceKind, SourceSpan};
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

/// The client ids that are set up as businesses.
pub async fn business_ids(
    conn: &mut SqliteConnection,
) -> Result<std::collections::BTreeSet<String>> {
    let ids: Vec<(String,)> = sqlx::query_as("SELECT client_id FROM businesses")
        .fetch_all(conn)
        .await?;
    Ok(ids.into_iter().map(|(id,)| id).collect())
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

/// One statement.
pub async fn statement(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredStatement>> {
    Ok(sqlx::query_as("SELECT * FROM statements WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

/// An uploaded statement's original file (M18). Statements uploaded before M18 have none.
/// A file uploaded again is read through the statement that first kept it.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct StatementFile {
    pub statement_id: String,
    /// Of `bytes`, in lower-case hex.
    pub sha256: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

pub async fn insert_statement_file(conn: &mut SqliteConnection, f: &StatementFile) -> Result<()> {
    sqlx::query(
        "INSERT INTO statement_files (statement_id, sha256, media_type, bytes)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&f.statement_id)
    .bind(&f.sha256)
    .bind(&f.media_type)
    .bind(&f.bytes)
    .execute(conn)
    .await?;
    Ok(())
}

/// Records that a statement's file is the one `same_as` already keeps (the same file uploaded
/// again), without storing its bytes a second time.
pub async fn insert_statement_file_same_as(
    conn: &mut SqliteConnection,
    statement_id: &str,
    same_as: &StatementFile,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO statement_files (statement_id, sha256, media_type, same_as)
         VALUES (?, ?, ?, ?)",
    )
    .bind(statement_id)
    .bind(&same_as.sha256)
    .bind(&same_as.media_type)
    .bind(&same_as.statement_id)
    .execute(conn)
    .await?;
    Ok(())
}

/// A statement's original file, if it was kept. `statement_id` of the result is the statement
/// whose row holds the bytes.
pub async fn statement_file(
    conn: &mut SqliteConnection,
    statement_id: &str,
) -> Result<Option<StatementFile>> {
    Ok(sqlx::query_as(
        "SELECT o.statement_id, o.sha256, o.media_type, o.bytes
         FROM statement_files f
         JOIN statement_files o ON o.statement_id = COALESCE(f.same_as, f.statement_id)
         WHERE f.statement_id = ?",
    )
    .bind(statement_id)
    .fetch_optional(conn)
    .await?)
}

/// The file with this SHA-256 that a bank account already keeps, from an earlier upload.
pub async fn kept_file(
    conn: &mut SqliteConnection,
    bank_account_id: &str,
    sha256: &str,
) -> Result<Option<StatementFile>> {
    Ok(sqlx::query_as(
        "SELECT f.statement_id, f.sha256, f.media_type, f.bytes
         FROM statement_files f JOIN statements s ON s.id = f.statement_id
         WHERE s.bank_account_id = ? AND f.sha256 = ? AND f.bytes IS NOT NULL",
    )
    .bind(bank_account_id)
    .bind(sha256)
    .fetch_optional(conn)
    .await?)
}

/// Where in its file a statement states one of its balances (M18).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalanceSpan {
    pub statement_id: String,
    pub balance: BalanceKind,
    pub span: SourceSpan,
}

#[derive(FromRow)]
struct BalanceSpanRow {
    statement_id: String,
    kind: String,
    bank_line_id: Option<String>,
    span_line: i64,
    span_start: i64,
    span_end: i64,
}

impl TryFrom<BalanceSpanRow> for BalanceSpan {
    type Error = crate::StoreError;
    fn try_from(r: BalanceSpanRow) -> Result<BalanceSpan> {
        let balance = match (r.kind.as_str(), r.bank_line_id) {
            ("opening", None) => BalanceKind::Opening,
            ("closing", None) => BalanceKind::Closing,
            ("running", Some(bank_line_id)) => BalanceKind::Running { bank_line_id },
            (kind, _) => {
                return Err(crate::StoreError::Corrupt(format!(
                    "balance span of kind {kind:?}"
                )));
            }
        };
        let n = |x: i64| {
            u32::try_from(x).map_err(|_| crate::StoreError::Corrupt(format!("span offset {x}")))
        };
        Ok(BalanceSpan {
            statement_id: r.statement_id,
            balance,
            span: SourceSpan {
                line: n(r.span_line)?,
                start: n(r.span_start)?,
                end: n(r.span_end)?,
            },
        })
    }
}

pub async fn insert_balance_span(conn: &mut SqliteConnection, s: &BalanceSpan) -> Result<()> {
    let (kind, bank_line_id) = match &s.balance {
        BalanceKind::Opening => ("opening", None),
        BalanceKind::Closing => ("closing", None),
        BalanceKind::Running { bank_line_id } => ("running", Some(bank_line_id.as_str())),
    };
    sqlx::query(
        "INSERT INTO balance_spans
             (statement_id, kind, bank_line_id, span_line, span_start, span_end)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.statement_id)
    .bind(kind)
    .bind(bank_line_id)
    .bind(i64::from(s.span.line))
    .bind(i64::from(s.span.start))
    .bind(i64::from(s.span.end))
    .execute(conn)
    .await?;
    Ok(())
}

/// A statement's balance spans, in file order.
pub async fn balance_spans(
    conn: &mut SqliteConnection,
    statement_id: &str,
) -> Result<Vec<BalanceSpan>> {
    let rows: Vec<BalanceSpanRow> = sqlx::query_as(
        "SELECT * FROM balance_spans WHERE statement_id = ?
         ORDER BY span_line, span_start, kind, bank_line_id",
    )
    .bind(statement_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(BalanceSpan::try_from).collect()
}

/// Every balance span of a bank account's statements, by statement then file order.
pub async fn balance_spans_for_account(
    conn: &mut SqliteConnection,
    bank_account_id: &str,
) -> Result<Vec<BalanceSpan>> {
    let rows: Vec<BalanceSpanRow> = sqlx::query_as(
        "SELECT b.* FROM balance_spans b JOIN statements s ON s.id = b.statement_id
         WHERE s.bank_account_id = ?
         ORDER BY b.statement_id, b.span_line, b.span_start, b.kind, b.bank_line_id",
    )
    .bind(bank_account_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(BalanceSpan::try_from).collect()
}

/// Deletes a statement, its lines and what hangs off each line (its coding state, the owner's
/// duplicate answer and supply-information confirmation, and any AI suggestions for it), its
/// balance spans and its kept file (M18, `remove_statement`). Journals are never deleted: the
/// caller reverses each line's live journal first, and `command_log` keeps the record.
///
/// If the statement's row holds the bytes of a file that a later upload points at (`same_as`),
/// the bytes move to the earliest such upload, and the others point at it instead.
pub async fn delete_statement(conn: &mut SqliteConnection, statement_id: &str) -> Result<()> {
    for sql in [
        "DELETE FROM bank_line_states
         WHERE bank_line_id IN (SELECT id FROM bank_lines WHERE statement_id = ?)",
        "DELETE FROM duplicate_answers
         WHERE bank_line_id IN (SELECT id FROM bank_lines WHERE statement_id = ?)",
        "DELETE FROM supply_info_confirmations
         WHERE bank_line_id IN (SELECT id FROM bank_lines WHERE statement_id = ?)",
        "DELETE FROM ai_suggestions
         WHERE bank_line_id IN (SELECT id FROM bank_lines WHERE statement_id = ?)",
    ] {
        sqlx::query(sql)
            .bind(statement_id)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("DELETE FROM balance_spans WHERE statement_id = ?")
        .bind(statement_id)
        .execute(&mut *conn)
        .await?;

    let heir: Option<(String,)> = sqlx::query_as(
        "SELECT statement_id FROM statement_files WHERE same_as = ? ORDER BY statement_id LIMIT 1",
    )
    .bind(statement_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((heir,)) = heir {
        sqlx::query(
            "UPDATE statement_files
             SET bytes = (SELECT bytes FROM statement_files WHERE statement_id = ?), same_as = NULL
             WHERE statement_id = ?",
        )
        .bind(statement_id)
        .bind(&heir)
        .execute(&mut *conn)
        .await?;
        sqlx::query("UPDATE statement_files SET same_as = ? WHERE same_as = ?")
            .bind(&heir)
            .bind(statement_id)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("DELETE FROM statement_files WHERE statement_id = ?")
        .bind(statement_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM bank_lines WHERE statement_id = ?")
        .bind(statement_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM statements WHERE id = ?")
        .bind(statement_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
