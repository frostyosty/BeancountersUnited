//! Helpers shared by the Xero parsers: CSV records with row numbers, header lookup, and reading
//! Xero's amounts, dates and account cells.

use acct_core::Money;
use chrono::NaiveDate;

use crate::history::HistoryError;

/// One non-blank CSV record and its 1-based line number.
#[derive(Debug, Clone)]
pub struct Record {
    pub row: u32,
    pub fields: Vec<String>,
}

impl Record {
    pub fn get(&self, i: usize) -> &str {
        self.fields.get(i).map_or("", String::as_str)
    }

    /// The non-empty cells.
    pub fn filled(&self) -> impl Iterator<Item = &str> {
        self.fields
            .iter()
            .map(String::as_str)
            .filter(|f| !f.is_empty())
    }
}

/// The file's non-blank records, cells trimmed. A byte order mark is ignored.
pub fn records(text: &str) -> Result<Vec<Record>, HistoryError> {
    let text = text.trim_start_matches('\u{feff}');
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut out = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| HistoryError::Unreadable {
            message: e.to_string(),
        })?;
        if record.iter().all(str::is_empty) {
            continue;
        }
        // Counted from the byte offset, because the csv crate's own line count is off for CRLF
        // files (Xero writes them) and after blank lines. Its offset can land on the line
        // break before the record, so skip those first.
        let row = record.position().map_or(0, |p| {
            let bytes = text.as_bytes();
            let mut at = usize::try_from(p.byte())
                .unwrap_or(usize::MAX)
                .min(bytes.len());
            while at < bytes.len() && matches!(bytes[at], b'\r' | b'\n') {
                at += 1;
            }
            let newlines = bytes[..at].iter().filter(|&&b| b == b'\n').count();
            u32::try_from(newlines + 1).unwrap_or(u32::MAX)
        });
        out.push(Record {
            row,
            fields: record.iter().map(str::to_owned).collect(),
        });
    }
    Ok(out)
}

/// A header cell reduced for matching: lowercase, without `*`, spaces, `-` or `_`. So
/// `*Tax Code`, `TaxCode` and `tax_code` all match `taxcode`.
pub fn key(cell: &str) -> String {
    cell.chars()
        .filter(|c| !matches!(c, '*' | ' ' | '-' | '_'))
        .flat_map(char::to_lowercase)
        .collect()
}

/// A header row's columns, found by name.
pub struct Header {
    pub names: Vec<String>,
    keys: Vec<String>,
}

impl Header {
    pub fn new(record: &Record) -> Header {
        Header {
            names: record.fields.clone(),
            keys: record.fields.iter().map(|f| key(f)).collect(),
        }
    }

    /// The first column whose name matches one of `names` (already in [`key`] form).
    pub fn find(&self, names: &[&str]) -> Option<usize> {
        self.keys.iter().position(|k| names.contains(&k.as_str()))
    }

    pub fn has(&self, names: &[&str]) -> bool {
        self.find(names).is_some()
    }

    pub fn name(&self, i: usize) -> String {
        self.names.get(i).cloned().unwrap_or_default()
    }
}

/// The first record (within the first `within`) whose keys include all of `required`.
pub fn find_header(
    records: &[Record],
    within: usize,
    required: &[&[&str]],
) -> Option<(usize, Header)> {
    records
        .iter()
        .take(within)
        .enumerate()
        .map(|(i, r)| (i, Header::new(r)))
        .find(|(_, h)| required.iter().all(|names| h.has(names)))
}

/// An amount as Xero writes it: `1,234.56`, `-1,234.56` or `(1,234.56)`. Blank is nil.
pub fn amount(raw: &str) -> Result<Money, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(Money::ZERO);
    }
    s.parse::<Money>().map_err(|e| e.to_string())
}

/// A date as Xero's exports write it: `1 Apr 2025`, `01 April 2025`, `01/04/2025` or
/// `2025-04-01`.
pub fn date(raw: &str) -> Option<NaiveDate> {
    let s = raw.trim();
    ["%d %b %Y", "%d %B %Y", "%d/%m/%Y", "%Y-%m-%d"]
        .iter()
        .find_map(|f| NaiveDate::parse_from_str(s, f).ok())
}

/// The first date found in a preamble line such as `As at 31 March 2025`, or the last in
/// `For the period 1 April 2024 to 31 March 2025` when `last` is set.
pub fn date_in(line: &str, last: bool) -> Option<NaiveDate> {
    let words: Vec<&str> = line.split_whitespace().collect();
    let mut found = (0..words.len().saturating_sub(2))
        .filter_map(|i| date(&words[i..i + 3].join(" ")))
        .chain(words.iter().filter_map(|w| date(w)));
    if last { found.last() } else { found.next() }
}

/// An account cell from a Xero report: `Sales (200)` or `200 - Sales`. Returns the code and the
/// name, or `None` when the cell carries no code.
pub fn split_account(cell: &str) -> Option<(String, String)> {
    let s = cell.trim();
    if let Some(open) = s.rfind(" (")
        && let Some(code) = s[open + 2..].strip_suffix(')')
        && is_code(code)
    {
        return Some((code.to_owned(), s[..open].trim().to_owned()));
    }
    if let Some((code, name)) = s.split_once(" - ")
        && is_code(code.trim())
    {
        return Some((code.trim().to_owned(), name.trim().to_owned()));
    }
    None
}

/// Xero account codes: up to 10 letters, digits or symbols, not starting with a symbol.
fn is_code(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 10
        && s.starts_with(|c: char| c.is_ascii_alphanumeric())
        && !s.contains(char::is_whitespace)
}

pub fn bad_row(
    record_row: u32,
    column: &str,
    value: &str,
    reason: impl Into<String>,
) -> HistoryError {
    HistoryError::BadRow {
        row: record_row,
        column: column.to_owned(),
        value: value.to_owned(),
        reason: reason.into(),
    }
}
