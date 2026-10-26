//! MYOB AccountRight and MYOB Business exports: the accounts list, the Trial Balance and
//! General Ledger [Detail] reports, and cards (contacts). Not MYOB AO Classic, which M16 reads on
//! an office machine.
//!
//! Every export is a delimited text file, tab or comma. [`detect`] tells them apart by their
//! header row, which may sit below a report's title lines. [`parse`] reads one into
//! [`crate::history`]'s shape. `docs/domain.md`, "Importing from Xero and MYOB", describes
//! the layouts and where each was documented.
//!
//! Account numbers are kept verbatim (`1-1110`). Amounts are integer cents, debit positive.
//! Dates are day first, as MYOB writes them in New Zealand.

mod accounts;
mod contacts;
mod fields;
mod gl;
mod tb;

#[cfg(test)]
mod tests;

use crate::history::{HistoryError, HistoryFile, HistoryImport, HistorySource};

/// Which MYOB export a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MyobExport {
    /// The accounts list: AccountRight's Export Data → Accounts, or MYOB Business's chart of
    /// accounts export.
    Accounts,
    /// The Trial Balance report.
    TrialBalance,
    /// The General Ledger [Detail] report.
    GeneralLedger,
    /// AccountRight's customer, supplier or personal cards export.
    Cards,
    /// MYOB Business's contacts report.
    Contacts,
}

/// How many rows of report title we look past to find the header.
const MAX_PREAMBLE: usize = 20;

/// A delimited file split into its title rows, its header and its data rows. Each row keeps
/// its line number in the file.
struct Table {
    preamble: Vec<Vec<String>>,
    /// Header names, normalised by [`fields::column_name`].
    header: Vec<String>,
    rows: Vec<(u32, Vec<String>)>,
}

impl Table {
    /// The first column with any of these (normalised) names.
    fn col(&self, names: &[&str]) -> Option<usize> {
        names
            .iter()
            .find_map(|n| self.header.iter().position(|h| h == n))
    }

    fn has(&self, name: &str) -> bool {
        self.header.iter().any(|h| h == name)
    }
}

/// The cell at `col`, or `""` when the column is missing or the row is short.
fn cell(row: &[String], col: Option<usize>) -> &str {
    col.and_then(|i| row.get(i)).map_or("", String::as_str)
}

/// What a header row says the file is.
fn classify(table: &Table) -> Option<(MyobExport, HistorySource)> {
    let account_col = table
        .col(&["account no.", "account no", "account number", "account"])
        .is_some();
    let debit = table.has("debit") || table.has("ytd debit");
    let credit = table.has("credit") || table.has("ytd credit");
    if table.has("co./last name") {
        Some((MyobExport::Cards, HistorySource::MyobAccountRight))
    } else if table.has("contact type") {
        Some((MyobExport::Contacts, HistorySource::MyobBusiness))
    } else if table.has("date") && debit && credit {
        Some((MyobExport::GeneralLedger, HistorySource::MyobAccountRight))
    } else if debit && credit && account_col {
        Some((MyobExport::TrialBalance, HistorySource::MyobAccountRight))
    } else if table.col(&["account number", "account no."]).is_some()
        && (table.has("account type") || table.has("header"))
    {
        let source = if table.has("parent account number") {
            HistorySource::MyobBusiness
        } else {
            HistorySource::MyobAccountRight
        };
        Some((MyobExport::Accounts, source))
    } else {
        None
    }
}

/// Splits the file into rows and finds its header.
fn read(text: &str) -> Result<(Table, MyobExport, HistorySource), HistoryError> {
    // The csv reader counts CRLF line endings as two lines, which would put row numbers off.
    let text = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let delimiter = if text
        .lines()
        .take(MAX_PREAMBLE + 1)
        .any(|l| l.contains('\t'))
    {
        b'\t'
    } else {
        b','
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut records = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| HistoryError::Unreadable {
            message: e.to_string(),
        })?;
        let cells: Vec<String> = record.iter().map(str::to_owned).collect();
        // Blank rows, and the `{}` row MYOB's import templates start with.
        if cells
            .iter()
            .all(|c| c.is_empty() || c.chars().all(|ch| "{} ".contains(ch)))
        {
            continue;
        }
        let row = record
            .position()
            .and_then(|p| u32::try_from(p.line()).ok())
            .unwrap_or(0);
        records.push((row, cells));
    }
    let Some(first) = records.first() else {
        return Err(HistoryError::Empty);
    };
    let first = first.1.clone();
    for i in 0..records.len().min(MAX_PREAMBLE + 1) {
        let table = Table {
            preamble: Vec::new(),
            header: records[i]
                .1
                .iter()
                .map(|h| fields::column_name(h))
                .collect(),
            rows: Vec::new(),
        };
        if let Some((kind, source)) = classify(&table) {
            let rows = records.split_off(i + 1);
            let preamble = records.into_iter().take(i).map(|(_, r)| r).collect();
            return Ok((
                Table {
                    preamble,
                    rows,
                    ..table
                },
                kind,
                source,
            ));
        }
    }
    Err(HistoryError::UnknownFormat { header: first })
}

/// Which MYOB export the file is, and from which product, without reading its rows.
///
/// Report exports (TB and GL detail) look the same from both products, so they're reported as
/// AccountRight; MYOB Business only exports reports to Excel, which the user saves as CSV.
pub fn detect(text: &str) -> Option<(MyobExport, HistorySource)> {
    read(text).ok().map(|(_, kind, source)| (kind, source))
}

/// Reads a MYOB export. Returns every problem found, each with its row, so they can all be
/// shown at once.
pub fn parse(text: &str) -> Result<HistoryImport, Vec<HistoryError>> {
    let (table, kind, source) = read(text).map_err(|e| vec![e])?;
    let file = match kind {
        MyobExport::Accounts => HistoryFile::Chart(accounts::parse(&table)?),
        MyobExport::TrialBalance => HistoryFile::Tb(tb::parse(&table)?),
        MyobExport::GeneralLedger => HistoryFile::Gl(gl::parse(&table)?),
        MyobExport::Cards | MyobExport::Contacts => HistoryFile::Contacts(contacts::parse(&table)?),
    };
    Ok(HistoryImport { source, file })
}
