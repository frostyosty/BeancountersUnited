//! What moving a year onto other template or mapping versions changes in its statements: the rows
//! that are new, gone, or show something different. Used to preview `move_year_layout` before
//! anything is pinned (CLAUDE.md, "Pushing a change onto existing data ... previews the diff").

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chart::AccountCode;
use crate::reportdoc::{ReportDoc, ReportRow, RowStyle};
use crate::template::LineKey;

/// A row as the preview shows it: its label, whole-dollar amounts and the accounts behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RowSummary {
    pub label: String,
    pub style: RowStyle,
    pub current: Option<i64>,
    pub prior: Option<i64>,
    pub accounts: Vec<AccountCode>,
}

impl From<&ReportRow> for RowSummary {
    fn from(r: &ReportRow) -> RowSummary {
        RowSummary {
            label: r.label.clone(),
            style: r.style,
            current: r.current,
            prior: r.prior,
            accounts: r.accounts.iter().map(|a| a.code.clone()).collect(),
        }
    }
}

/// One row that differs. `before` is `None` for a new row, `after` for one that's gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RowChange {
    /// The statement's title (after the move, or before it for a row that's gone).
    pub statement: String,
    pub key: LineKey,
    pub before: Option<RowSummary>,
    pub after: Option<RowSummary>,
}

/// A row is the same row in both documents when its statement, key and style match: a group's
/// heading and its total share a key but are different rows.
type RowId<'a> = (&'a LineKey, &'a LineKey, RowStyle);

fn rows(doc: &ReportDoc) -> Vec<(RowId<'_>, &str, &ReportRow)> {
    doc.statements
        .iter()
        .flat_map(|s| {
            s.rows
                .iter()
                .map(move |r| ((&s.key, &r.key, r.style), s.title.as_str(), r))
        })
        .collect()
}

/// Every row that's new, gone or shows something different, in the order of `after`, then the
/// rows that are gone in the order of `before`.
pub fn row_changes(before: &ReportDoc, after: &ReportDoc) -> Vec<RowChange> {
    let old = rows(before);
    let new = rows(after);
    let old_by_id: BTreeMap<RowId<'_>, &ReportRow> =
        old.iter().map(|(id, _, r)| (*id, *r)).collect();
    let new_by_id: BTreeMap<RowId<'_>, &ReportRow> =
        new.iter().map(|(id, _, r)| (*id, *r)).collect();
    let mut out = Vec::new();
    for (id, title, row) in &new {
        let after = RowSummary::from(*row);
        let before = old_by_id.get(id).map(|r| RowSummary::from(*r));
        if before.as_ref() != Some(&after) {
            out.push(RowChange {
                statement: (*title).to_owned(),
                key: id.1.clone(),
                before,
                after: Some(after),
            });
        }
    }
    for (id, title, row) in &old {
        if !new_by_id.contains_key(id) {
            out.push(RowChange {
                statement: (*title).to_owned(),
                key: id.1.clone(),
                before: Some(RowSummary::from(*row)),
                after: None,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reportdoc::{Comparatives, Period, ReportStatement};
    use chrono::NaiveDate;

    fn key(s: &str) -> LineKey {
        s.parse().unwrap()
    }

    fn row(k: &str, label: &str, current: i64, accounts: &[&str]) -> ReportRow {
        ReportRow {
            key: key(k),
            style: RowStyle::Line,
            depth: 1,
            label: label.into(),
            current: Some(current),
            prior: None,
            accounts: accounts
                .iter()
                .map(|c| crate::reportdoc::RowAccount {
                    code: c.parse().unwrap(),
                    current: crate::Money::ZERO,
                    prior: crate::Money::ZERO,
                })
                .collect(),
            rounding: None,
        }
    }

    fn doc(rows: Vec<ReportRow>) -> ReportDoc {
        let d = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        ReportDoc {
            template: "T".into(),
            current_period: Period { start: d, end: d },
            prior_period: None,
            comparatives: Comparatives::None,
            statements: vec![ReportStatement {
                key: key("performance"),
                title: "Performance".into(),
                rows,
            }],
            asset_schedule: None,
            notes: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn same_documents_have_no_changes() {
        let d = doc(vec![row("sales", "Sales", 100, &["100"])]);
        assert_eq!(row_changes(&d, &d), vec![]);
    }

    #[test]
    fn lists_moved_accounts_new_rows_and_gone_rows() {
        let before = doc(vec![
            row("sales", "Sales", 100, &["100", "110"]),
            row("other", "Other", 5, &[]),
        ]);
        let after = doc(vec![
            row("sales", "Sales", 90, &["100"]),
            row("interest", "Interest", 10, &["110"]),
        ]);
        let changes = row_changes(&before, &after);
        let summary: Vec<(&str, bool, bool)> = changes
            .iter()
            .map(|c| (c.key.as_str(), c.before.is_some(), c.after.is_some()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("sales", true, true),
                ("interest", false, true),
                ("other", true, false)
            ]
        );
        assert_eq!(changes[0].after.as_ref().unwrap().current, Some(90));
    }

    #[test]
    fn a_heading_and_its_total_are_different_rows() {
        let mut heading = row("revenue", "Revenue", 0, &[]);
        heading.style = RowStyle::Heading;
        heading.current = None;
        let mut total = row("revenue", "Total revenue", 100, &[]);
        total.style = RowStyle::GroupTotal;
        let before = doc(vec![heading.clone(), total]);
        let after = doc(vec![heading]);
        let changes = row_changes(&before, &after);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].before.as_ref().unwrap().style,
            RowStyle::GroupTotal
        );
    }
}
