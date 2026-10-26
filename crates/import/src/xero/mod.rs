//! Xero's standard exports: chart of accounts, trial balance, general ledger detail (the
//! Account Transactions report) and contacts.
//!
//! [`parse`] takes the file's decoded text, works out which export it is by inspecting it
//! ([`detect`]), and returns it in [`crate::history`]'s shape. `docs/domain.md`, "Importing from
//! Xero and MYOB", describes each layout and where it's documented.
//!
//! Reports (TB and Account Transactions) are exported with a title preamble (report name,
//! organisation, date or period), then a header row, then the body. Charts and contacts are
//! plain CSVs with a header row. Headers are matched ignoring case, spaces and Xero's `*`
//! (which marks a required column in its import templates), never by position.

mod chart;
mod contacts;
mod gl;
mod tb;
mod text;

use crate::history::{HistoryError, HistoryFile, HistoryImport, HistorySource};

/// Which Xero export a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XeroExport {
    ChartOfAccounts,
    TrialBalance,
    AccountTransactions,
    Contacts,
}

/// Works out which export a file is, or `None` if it isn't one we read.
pub fn detect(text: &str) -> Option<XeroExport> {
    let records = text::records(text).ok()?;
    if chart::detect(&records) {
        Some(XeroExport::ChartOfAccounts)
    } else if contacts::detect(&records) {
        Some(XeroExport::Contacts)
    } else if gl::detect(&records) {
        Some(XeroExport::AccountTransactions)
    } else if tb::detect(&records) {
        Some(XeroExport::TrialBalance)
    } else {
        None
    }
}

/// Reads a Xero export. Returns every problem found, each with its row, so they can all be
/// shown at once.
pub fn parse(text: &str) -> Result<HistoryImport, Vec<HistoryError>> {
    let records = text::records(text).map_err(|e| vec![e])?;
    if records.is_empty() {
        return Err(vec![HistoryError::Empty]);
    }
    let file = if chart::detect(&records) {
        HistoryFile::Chart(chart::parse(&records)?)
    } else if contacts::detect(&records) {
        HistoryFile::Contacts(contacts::parse(&records)?)
    } else if gl::detect(&records) {
        HistoryFile::Gl(gl::parse(&records)?)
    } else if tb::detect(&records) {
        HistoryFile::Tb(tb::parse(&records)?)
    } else {
        return Err(vec![HistoryError::UnknownFormat {
            header: records[0].fields.clone(),
        }]);
    };
    Ok(HistoryImport {
        source: HistorySource::Xero,
        file,
    })
}

#[cfg(test)]
mod tests;
