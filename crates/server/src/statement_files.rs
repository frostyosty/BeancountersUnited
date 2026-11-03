//! The bank's own words (M18): a few lines of an uploaded statement's original file around one of
//! its balances, for the "Your bank's file says" side of Bank vs books.
//!
//! `import_statement` keeps each file in `statement_files` and where each balance sits in it in
//! `balance_spans`. Statements uploaded before M18 have no file kept; their excerpt says so and
//! carries the stored figure instead.

use acct_core::Money;
use acct_core::reconcile::{BalanceKind, SourceSpan};
use acct_import::bank::decode;
use acct_store::SqliteConnection;
use acct_store::bank::{self as bank_store, BalanceSpan};
use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::CommandError;

/// How many lines either side of the balance's line the excerpt shows.
const CONTEXT_LINES: u32 = 3;
/// Longer lines are cut, around the balance on its own line, so a one-line XML file stays short.
const MAX_LINE_CHARS: usize = 200;
/// How much of a long line to keep either side of the balance.
const AROUND_CHARS: usize = 80;

/// Which balance: `?kind=opening`, `?kind=closing` (the default), or `?line=<bank_line_id>` for a
/// line's running balance.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct ExcerptQuery {
    #[ts(optional)]
    pub kind: Option<String>,
    #[ts(optional)]
    pub line: Option<String>,
}

/// One line of the file, as the parser decoded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ExcerptLine {
    /// The file's 1-based line number.
    pub number: u32,
    pub text: String,
}

/// Where the balance is on its line. `start` and `end` count UTF-16 code units within that
/// line's `text`, so the web app can `slice` it as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ExcerptHighlight {
    pub line: u32,
    pub start: u32,
    pub end: u32,
}

/// `GET /api/statements/{id}/excerpt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct StatementExcerpt {
    pub statement_id: String,
    pub file_name: String,
    /// Whether the original file was kept. Statements uploaded before M18 weren't.
    pub kept: bool,
    pub sha256: Option<String>,
    pub media_type: Option<String>,
    /// The balance as stored: the bank's figure, or worked out from the lines where the file
    /// gave none. Signed from the account's point of view, so a card balance owed is negative.
    pub stated: Option<Money>,
    /// The day the balance is for: the start of it for an opening balance, the end otherwise.
    #[ts(type = "string")]
    pub date: NaiveDate,
    /// Up to three lines either side of the balance's line. Empty when the file wasn't kept, or
    /// the file doesn't state this balance (a closing balance worked out from the lines).
    pub lines: Vec<ExcerptLine>,
    pub highlight: Option<ExcerptHighlight>,
}

/// `GET /api/statements/{id}/excerpt`. The access layer has already checked the statement, as
/// for reading its business (`access::RouteRule::Statement`).
pub async fn get_excerpt(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
    query: Result<Query<ExcerptQuery>, QueryRejection>,
) -> Result<Json<StatementExcerpt>, CommandError> {
    let Query(q) = query.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let mut conn = state.store.reader().await?;
    Ok(Json(excerpt(&mut conn, &id, &q).await?))
}

/// The excerpt for one of a statement's balances.
pub async fn excerpt(
    conn: &mut SqliteConnection,
    statement_id: &str,
    q: &ExcerptQuery,
) -> Result<StatementExcerpt, CommandError> {
    let statement = bank_store::statement(conn, statement_id)
        .await?
        .ok_or_else(|| CommandError::not_found("statement", statement_id))?;
    let (balance, stated, date) = match (q.kind.as_deref(), &q.line) {
        (None | Some("running"), Some(line_id)) => {
            let line = bank_store::bank_line(conn, line_id)
                .await?
                .filter(|l| l.statement_id == statement.id)
                .ok_or_else(|| CommandError::not_found("bank line", line_id))?;
            let kind = BalanceKind::Running {
                bank_line_id: line.id.clone(),
            };
            (kind, line.balance, line.date)
        }
        (Some("opening"), None) => (
            BalanceKind::Opening,
            statement.opening_balance.map(Money::from_cents),
            statement.start_date,
        ),
        (None | Some("closing"), None) => (
            BalanceKind::Closing,
            statement.closing_balance.map(Money::from_cents),
            statement.end_date,
        ),
        (Some("running"), None) => {
            return Err(CommandError::Malformed(
                "a running balance needs `line`, the bank line's id".to_owned(),
            ));
        }
        (Some(kind), _) => {
            return Err(CommandError::Malformed(format!(
                "kind is opening, closing or running, not {kind:?}"
            )));
        }
    };
    let mut out = StatementExcerpt {
        statement_id: statement.id.clone(),
        file_name: statement.file_name.clone(),
        kept: false,
        sha256: None,
        media_type: None,
        stated,
        date,
        lines: Vec::new(),
        highlight: None,
    };
    let Some(file) = bank_store::statement_file(conn, &statement.id).await? else {
        return Ok(out);
    };
    out.kept = true;
    out.sha256 = Some(file.sha256);
    out.media_type = Some(file.media_type);
    let spans = bank_store::balance_spans(conn, &statement.id).await?;
    if let Some(BalanceSpan { span, .. }) = spans.into_iter().find(|s| s.balance == balance) {
        let (lines, highlight) = around(&decode(&file.bytes), span);
        out.lines = lines;
        out.highlight = highlight;
    }
    Ok(out)
}

/// The lines around `span`, with long lines cut, and where the span is on its line.
fn around(text: &str, span: SourceSpan) -> (Vec<ExcerptLine>, Option<ExcerptHighlight>) {
    let first = span.line.saturating_sub(CONTEXT_LINES).max(1);
    let last = span.line.saturating_add(CONTEXT_LINES);
    let mut lines = Vec::new();
    let mut highlight = None;
    for (number, line) in (1u32..).zip(text.split('\n')) {
        if number < first {
            continue;
        }
        if number > last {
            break;
        }
        if number == span.line {
            let (cut, start, end) = cut_around(line, span.start as usize, span.end as usize);
            let units = |s: &str| u32::try_from(s.encode_utf16().count()).unwrap_or(u32::MAX);
            highlight = Some(ExcerptHighlight {
                line: number,
                start: units(&cut[..start]),
                end: units(&cut[..end]),
            });
            lines.push(ExcerptLine { number, text: cut });
        } else {
            lines.push(ExcerptLine {
                number,
                text: shorten(line),
            });
        }
    }
    // A span past the end of the file (it can't be, but a bad row shouldn't break the page).
    if highlight.is_none() {
        lines.clear();
    }
    (lines, highlight)
}

/// A line cut to [`MAX_LINE_CHARS`], marked with `…` where it was cut.
fn shorten(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        Some((i, _)) => format!("{}…", &line[..i]),
        None => line.to_owned(),
    }
}

/// The span's line, cut around the span if it's long, and the span's byte range in what's left.
/// Offsets past the line, or off a character boundary, are pulled back onto it.
fn cut_around(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    let floor = |mut i: usize| {
        i = i.min(line.len());
        while !line.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let (start, end) = (floor(start), floor(end.max(start)));
    if line.chars().count() <= MAX_LINE_CHARS {
        return (line.to_owned(), start, end);
    }
    let from = line[..start]
        .char_indices()
        .rev()
        .nth(AROUND_CHARS - 1)
        .map_or(0, |(i, _)| i);
    let to = line[end..]
        .char_indices()
        .nth(AROUND_CHARS)
        .map_or(line.len(), |(i, _)| end + i);
    let prefix = if from > 0 { "…" } else { "" };
    let suffix = if to < line.len() { "…" } else { "" };
    let cut = format!("{prefix}{}{suffix}", &line[from..to]);
    (cut, prefix.len() + start - from, prefix.len() + end - from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(line: u32, start: u32, end: u32) -> SourceSpan {
        SourceSpan { line, start, end }
    }

    #[test]
    fn three_lines_either_side() {
        let text = (1..=10)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (lines, highlight) = around(&text, span(5, 5, 6));
        let numbers: Vec<u32> = lines.iter().map(|l| l.number).collect();
        assert_eq!(numbers, [2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(
            highlight,
            Some(ExcerptHighlight {
                line: 5,
                start: 5,
                end: 6
            })
        );
        let (lines, _) = around(&text, span(1, 0, 4));
        assert_eq!(lines.first().map(|l| l.number), Some(1));
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn highlights_count_utf16_units() {
        let (lines, highlight) = around("Café ā,12.50", span(1, 9, 14));
        let h = highlight.unwrap();
        let units: Vec<u16> = lines[0].text.encode_utf16().collect();
        let marked = String::from_utf16(&units[h.start as usize..h.end as usize]).unwrap();
        assert_eq!(marked, "12.50");
    }

    #[test]
    fn a_long_line_is_cut_around_the_balance() {
        let line = format!(
            "{}<BALAMT>2022.56</BALAMT>{}",
            "x".repeat(500),
            "y".repeat(500)
        );
        let start = 508;
        let (lines, highlight) = around(&line, span(1, start, start + 7));
        let h = highlight.unwrap();
        let text = &lines[0].text;
        assert!(text.starts_with('…') && text.ends_with('…'), "{text}");
        let units: Vec<u16> = text.encode_utf16().collect();
        let marked = String::from_utf16(&units[h.start as usize..h.end as usize]).unwrap();
        assert_eq!(marked, "2022.56");
        assert!(text.chars().count() < 200, "{}", text.chars().count());
    }

    #[test]
    fn a_span_past_the_file_shows_nothing() {
        assert_eq!(around("a\nb", span(9, 0, 1)), (Vec::new(), None));
    }
}
