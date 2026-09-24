//! Building a ReportDoc: statements with whole-dollar amounts, comparatives, rounding and the
//! accounts behind each line.
//!
//! The rounding rules are in `docs/domain.md`. In short, working separately on each column:
//! 1. every line starts at its exact amount rounded;
//! 2. statement by statement, links copy their (already settled) target;
//! 3. groups, innermost first, are brought to their exact total rounded;
//! 4. totals, protected ones first in priority order, are brought to their exact total rounded.
//!
//! A row is "brought to" its target by moving the difference onto one absorbing line inside it,
//! chosen from the client's rounding priority list (or the largest line, with a warning). Lines
//! under a protected group or total that has already been settled are frozen, so later
//! adjustments can't disturb it. Group and total amounts are always the sum of the lines under
//! them, so every column foots by construction.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::chart::AccountCode;
use crate::depreciation::AssetSchedule;
use crate::ledger::{ClientYear, TrialBalance};
use crate::mapping::{Mapping, MappingError};
use crate::money::Money;
use crate::template::{LineKey, Node, Presentation, Template, TemplateError};

/// The built statements. Holds no ids, timestamps or hash maps, so its JSON is byte-stable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportDoc {
    pub template: String,
    pub current_period: Period,
    pub prior_period: Option<Period>,
    pub comparatives: Comparatives,
    pub statements: Vec<ReportStatement>,
    /// The fixed asset schedule, when the client has an asset register. Built separately by
    /// [`crate::depreciation::build_asset_schedule`] and attached by the caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub asset_schedule: Option<AssetSchedule>,
    pub warnings: Vec<ReportWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Period {
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
}

impl From<&ClientYear> for Period {
    fn from(y: &ClientYear) -> Period {
        Period {
            start: y.start(),
            end: y.end(),
        }
    }
}

/// Where the prior-year column came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Comparatives {
    /// No prior year.
    None,
    /// The prior year's finalised snapshot TB.
    Finalised,
    /// The prior year's live TB: it isn't finalised yet, and the figures may still change.
    Unfinalised,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportStatement {
    pub key: LineKey,
    pub title: String,
    pub rows: Vec<ReportRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum RowStyle {
    /// A group's heading. No amounts.
    Heading,
    /// A line that accounts map to.
    Line,
    /// A figure repeated from an earlier statement.
    Link,
    /// A group's total, shown after its children.
    GroupTotal,
    /// A total of other rows.
    Total,
}

/// One row as shown. Amounts are whole dollars in presentation sign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportRow {
    pub key: LineKey,
    pub style: RowStyle,
    pub depth: u8,
    pub label: String,
    pub current: Option<i64>,
    pub prior: Option<i64>,
    /// For lines: the accounts behind the line, for drill-down.
    pub accounts: Vec<RowAccount>,
    /// For lines that absorbed rounding: the dollars added, per column (zero if none).
    pub rounding: Option<RowRounding>,
}

/// An account behind a line, with its real balances in cents, in the line's presentation sign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RowAccount {
    pub code: AccountCode,
    pub current: Money,
    pub prior: Money,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RowRounding {
    pub current: i64,
    pub prior: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Column {
    Current,
    Prior,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum ReportWarning {
    /// No account on the rounding priority list qualified, so the largest line took the rounding.
    RoundingFallback {
        column: Column,
        row: LineKey,
        line: LineKey,
    },
    /// A row couldn't be brought to its exact total rounded, because every line under it is
    /// frozen by a protected total. It shows the sum of its lines instead.
    CannotRound {
        column: Column,
        row: LineKey,
        difference: i64,
    },
    /// Two rows the template says must agree don't.
    CheckFailed {
        column: Column,
        left: LineKey,
        right: LineKey,
        left_amount: i64,
        right_amount: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BuildError {
    #[error("template: {0}")]
    Template(TemplateError),
    #[error("mapping: {0}")]
    Mapping(MappingError),
    #[error("the {column:?} trial balance is out of balance by {difference}")]
    UnbalancedTb { column: Column, difference: Money },
}

/// The prior year's figures for the comparative column.
#[derive(Debug, Clone, Copy)]
pub struct Prior<'a> {
    pub year: &'a ClientYear,
    pub tb: &'a TrialBalance,
    pub finalised: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ReportInput<'a> {
    pub template: &'a Template,
    pub mapping: &'a Mapping,
    pub year: &'a ClientYear,
    pub tb: &'a TrialBalance,
    pub prior: Option<Prior<'a>>,
    /// The client's rounding priority list: account codes, most preferred first.
    pub rounding_priority: &'a [AccountCode],
}

/// Builds the ReportDoc. The same input always gives byte-identical JSON.
pub fn build_report(input: &ReportInput<'_>) -> Result<ReportDoc, Vec<BuildError>> {
    let mut errors = Vec::new();
    if let Err(es) = input.template.validate() {
        errors.extend(es.into_iter().map(BuildError::Template));
    }
    if let Err(es) = input.mapping.validate(input.template) {
        errors.extend(es.into_iter().map(BuildError::Mapping));
    }
    let tbs = column_tbs(input);
    for &(column, tb) in &tbs {
        if !tb.is_balanced() {
            errors.push(BuildError::UnbalancedTb {
                column,
                difference: tb.total(),
            });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let assigned = input
        .mapping
        .assign(tbs.iter().map(|&(_, tb)| tb))
        .map_err(|es| es.into_iter().map(BuildError::Mapping).collect::<Vec<_>>())?;

    let index = Index::new(input.template);
    let mut warnings = Vec::new();
    let columns: Vec<ColumnState> = tbs
        .iter()
        .map(|&(column, tb)| {
            let mut state = ColumnState::new(&index, &assigned, column, tb);
            state.settle(&index, input.rounding_priority, &mut warnings);
            state
        })
        .collect();
    for check in &input.template.checks {
        for state in &columns {
            // Compare the amounts as shown, in each row's presentation sign.
            let shown = |key: &LineKey| {
                let id = index.id(key);
                presentation_of(index.nodes[id]).apply(state.shown_of(&index, id))
            };
            let (l, r) = (shown(&check.left), shown(&check.right));
            if l != r {
                warnings.push(ReportWarning::CheckFailed {
                    column: state.column,
                    left: check.left.clone(),
                    right: check.right.clone(),
                    left_amount: l,
                    right_amount: r,
                });
            }
        }
    }

    let statements = input
        .template
        .statements
        .iter()
        .map(|s| ReportStatement {
            key: s.key.clone(),
            title: s.title.clone(),
            rows: s
                .body
                .iter()
                .flat_map(|n| rows_for(n, 0, &index, &columns, &assigned, &tbs))
                .collect(),
        })
        .collect();

    Ok(ReportDoc {
        template: input.template.name.clone(),
        current_period: input.year.into(),
        prior_period: input.prior.map(|p| p.year.into()),
        comparatives: match input.prior {
            None => Comparatives::None,
            Some(p) if p.finalised => Comparatives::Finalised,
            Some(_) => Comparatives::Unfinalised,
        },
        statements,
        asset_schedule: None,
        warnings,
    })
}

fn column_tbs<'a>(input: &ReportInput<'a>) -> Vec<(Column, &'a TrialBalance)> {
    let mut tbs = vec![(Column::Current, input.tb)];
    if let Some(p) = input.prior {
        tbs.push((Column::Prior, p.tb));
    }
    tbs
}

/// The template flattened into document order, with parent links.
struct Index<'a> {
    nodes: Vec<&'a Node>,
    statement: Vec<usize>,
    children: Vec<Vec<usize>>,
    ids: BTreeMap<&'a LineKey, usize>,
    statement_count: usize,
}

impl<'a> Index<'a> {
    fn new(template: &'a Template) -> Index<'a> {
        let mut index = Index {
            nodes: Vec::new(),
            statement: Vec::new(),
            children: Vec::new(),
            ids: BTreeMap::new(),
            statement_count: template.statements.len(),
        };
        for (s, statement) in template.statements.iter().enumerate() {
            for node in &statement.body {
                index.add(node, s);
            }
        }
        index
    }

    fn add(&mut self, node: &'a Node, statement: usize) -> usize {
        let id = self.nodes.len();
        self.nodes.push(node);
        self.statement.push(statement);
        self.children.push(Vec::new());
        self.ids.insert(node.key(), id);
        if let Node::Group { children, .. } = node {
            let kids = children.iter().map(|c| self.add(c, statement)).collect();
            self.children[id] = kids;
        }
        id
    }

    fn id(&self, key: &LineKey) -> usize {
        self.ids[key]
    }

    /// The rows whose amounts a group or total adds up.
    fn parts(&self, id: usize) -> Vec<usize> {
        match self.nodes[id] {
            Node::Group { .. } => self.children[id].clone(),
            Node::Total { of, .. } => of.iter().map(|k| self.id(k)).collect(),
            _ => Vec::new(),
        }
    }

    /// The Line rows under a row, in document order. Links aren't included: they can't absorb
    /// rounding because their figure belongs to another statement.
    fn lines_under(&self, id: usize) -> Vec<usize> {
        let mut out = Vec::new();
        self.collect_lines(id, &mut out);
        out.sort_unstable();
        out.dedup();
        out
    }

    fn collect_lines(&self, id: usize, out: &mut Vec<usize>) {
        match self.nodes[id] {
            Node::Line { .. } => out.push(id),
            Node::Link { .. } => {}
            _ => {
                for part in self.parts(id) {
                    self.collect_lines(part, out);
                }
            }
        }
    }

    /// Groups in `statement`, innermost first.
    fn groups_bottom_up(&self, statement: usize) -> Vec<usize> {
        let mut out = Vec::new();
        for id in 0..self.nodes.len() {
            if self.statement[id] == statement && is_top_level(self, id) {
                self.post_order_groups(id, &mut out);
            }
        }
        out
    }

    fn post_order_groups(&self, id: usize, out: &mut Vec<usize>) {
        for &child in &self.children[id] {
            self.post_order_groups(child, out);
        }
        if matches!(self.nodes[id], Node::Group { .. }) {
            out.push(id);
        }
    }
}

fn is_top_level(index: &Index<'_>, id: usize) -> bool {
    !index.children.iter().any(|kids| kids.contains(&id))
}

fn protect_of(node: &Node) -> Option<u8> {
    match node {
        Node::Group { protect, .. } | Node::Total { protect, .. } => *protect,
        _ => None,
    }
}

fn presentation_of(node: &Node) -> Presentation {
    match node {
        Node::Group { presentation, .. }
        | Node::Line { presentation, .. }
        | Node::Total { presentation, .. }
        | Node::Link { presentation, .. } => *presentation,
    }
}

fn round_cents(cents: i64) -> i64 {
    Money::from_cents(cents).round_to_dollars()
}

/// One column's working: exact cents and shown dollars, both in ledger sign.
struct ColumnState<'a> {
    column: Column,
    tb: &'a TrialBalance,
    assigned: &'a BTreeMap<AccountCode, LineKey>,
    exact: Vec<i64>,
    /// Shown dollars for Line and Link rows. Groups and totals are sums of these.
    shown: Vec<i64>,
    frozen: Vec<bool>,
}

impl<'a> ColumnState<'a> {
    fn new(
        index: &Index<'_>,
        assigned: &'a BTreeMap<AccountCode, LineKey>,
        column: Column,
        tb: &'a TrialBalance,
    ) -> ColumnState<'a> {
        let n = index.nodes.len();
        let mut line_cents = vec![0i64; n];
        for (code, balance) in tb.iter() {
            let line = index.id(&assigned[code]);
            line_cents[line] += balance.cents();
        }
        let mut state = ColumnState {
            column,
            tb,
            assigned,
            exact: vec![0; n],
            shown: vec![0; n],
            frozen: vec![false; n],
        };
        for id in 0..n {
            state.exact[id] = state.exact_of(index, id, &line_cents);
            if matches!(index.nodes[id], Node::Line { .. }) {
                state.shown[id] = round_cents(state.exact[id]);
            }
        }
        state
    }

    fn exact_of(&self, index: &Index<'_>, id: usize, line_cents: &[i64]) -> i64 {
        match index.nodes[id] {
            Node::Line { .. } => line_cents[id],
            Node::Link { from, .. } => self.exact_of(index, index.id(from), line_cents),
            _ => index
                .parts(id)
                .iter()
                .map(|&p| self.exact_of(index, p, line_cents))
                .sum(),
        }
    }

    /// A row's shown amount in ledger sign.
    fn shown_of(&self, index: &Index<'_>, id: usize) -> i64 {
        match index.nodes[id] {
            Node::Line { .. } | Node::Link { .. } => self.shown[id],
            _ => index
                .parts(id)
                .iter()
                .map(|&p| self.shown_of(index, p))
                .sum(),
        }
    }

    fn settle(
        &mut self,
        index: &Index<'_>,
        priority: &[AccountCode],
        warnings: &mut Vec<ReportWarning>,
    ) {
        for statement in 0..index.statement_count {
            let in_statement = |id: &usize| index.statement[*id] == statement;
            for id in (0..index.nodes.len()).filter(in_statement) {
                if let Node::Link { from, .. } = index.nodes[id] {
                    self.shown[id] = self.shown_of(index, index.id(from));
                }
            }
            for id in index.groups_bottom_up(statement) {
                self.bring_to_target(index, id, priority, warnings);
            }
            let mut totals: Vec<usize> = (0..index.nodes.len())
                .filter(in_statement)
                .filter(|&id| matches!(index.nodes[id], Node::Total { .. }))
                .collect();
            // Protected totals first, by priority; then the rest in document order.
            totals.sort_by_key(|&id| (protect_of(index.nodes[id]).map_or((1, 0), |p| (0, p)), id));
            for id in totals {
                self.bring_to_target(index, id, priority, warnings);
            }
        }
    }

    /// Moves any difference between a row's shown amount and its exact total rounded onto one
    /// absorbing line under it. Protected rows then freeze their lines.
    fn bring_to_target(
        &mut self,
        index: &Index<'_>,
        id: usize,
        priority: &[AccountCode],
        warnings: &mut Vec<ReportWarning>,
    ) {
        let node = index.nodes[id];
        let difference = round_cents(self.exact[id]) - self.shown_of(index, id);
        let candidates: Vec<usize> = index
            .lines_under(id)
            .into_iter()
            .filter(|&l| !self.frozen[l])
            .collect();
        if difference != 0 {
            match self.absorber(index, &candidates, priority) {
                Some((line, fallback)) => {
                    self.shown[line] += difference;
                    if fallback {
                        warnings.push(ReportWarning::RoundingFallback {
                            column: self.column,
                            row: node.key().clone(),
                            line: index.nodes[line].key().clone(),
                        });
                    }
                }
                None => warnings.push(ReportWarning::CannotRound {
                    column: self.column,
                    row: node.key().clone(),
                    difference: presentation_of(node).apply(difference),
                }),
            }
        }
        if protect_of(node).is_some() {
            for line in index.lines_under(id) {
                self.frozen[line] = true;
            }
        }
    }

    /// The first account on the priority list with a balance in this column whose line is a
    /// candidate; otherwise the candidate with the largest shown amount (earliest on ties).
    /// The flag is true for the fallback.
    fn absorber(
        &self,
        index: &Index<'_>,
        candidates: &[usize],
        priority: &[AccountCode],
    ) -> Option<(usize, bool)> {
        for code in priority {
            if self.tb.balance(code).is_zero() {
                continue;
            }
            if let Some(line) = self.assigned.get(code).map(|k| index.id(k))
                && candidates.contains(&line)
            {
                return Some((line, false));
            }
        }
        let mut best: Option<usize> = None;
        for &c in candidates {
            if best.is_none_or(|b| self.shown[c].abs() > self.shown[b].abs()) {
                best = Some(c);
            }
        }
        best.map(|b| (b, true))
    }
}

/// The rows for a node. A line or link that shows zero in every column is left out, and so is a
/// group whose rows are all left out and whose totals are zero. Totals always show.
fn rows_for(
    node: &Node,
    depth: u8,
    index: &Index<'_>,
    columns: &[ColumnState<'_>],
    assigned: &BTreeMap<AccountCode, LineKey>,
    tbs: &[(Column, &TrialBalance)],
) -> Vec<ReportRow> {
    let id = index.id(node.key());
    let p = presentation_of(node);
    let shown = |col: usize| columns.get(col).map(|c| p.apply(c.shown_of(index, id)));
    let all_zero = columns.iter().all(|c| c.shown_of(index, id) == 0);
    let row = |style: RowStyle, label: &str, with_amounts: bool| ReportRow {
        key: node.key().clone(),
        style,
        depth,
        label: label.to_owned(),
        current: if with_amounts { shown(0) } else { None },
        prior: if with_amounts { shown(1) } else { None },
        accounts: Vec::new(),
        rounding: None,
    };
    match node {
        Node::Line { label, .. } => {
            if all_zero {
                return Vec::new();
            }
            let mut r = row(RowStyle::Line, label, true);
            let balance = |col: usize, code: &AccountCode| {
                let cents = tbs.get(col).map_or(0, |(_, tb)| tb.balance(code).cents());
                Money::from_cents(p.apply(cents))
            };
            r.accounts = assigned
                .iter()
                .filter(|(_, line)| *line == node.key())
                .map(|(code, _)| RowAccount {
                    code: code.clone(),
                    current: balance(0, code),
                    prior: balance(1, code),
                })
                .collect();
            let adj = |col: usize| {
                columns
                    .get(col)
                    .map_or(0, |c| p.apply(c.shown[id] - round_cents(c.exact[id])))
            };
            if adj(0) != 0 || adj(1) != 0 {
                r.rounding = Some(RowRounding {
                    current: adj(0),
                    prior: adj(1),
                });
            }
            vec![r]
        }
        Node::Link { label, .. } => {
            if all_zero {
                Vec::new()
            } else {
                vec![row(RowStyle::Link, label, true)]
            }
        }
        Node::Total { label, .. } => vec![row(RowStyle::Total, label, true)],
        Node::Group {
            label,
            children,
            total_label,
            ..
        } => {
            let inner: Vec<ReportRow> = children
                .iter()
                .flat_map(|c| rows_for(c, depth.saturating_add(1), index, columns, assigned, tbs))
                .collect();
            if inner.is_empty() && all_zero {
                return Vec::new();
            }
            let mut out = vec![row(RowStyle::Heading, label, false)];
            out.extend(inner);
            if let Some(total_label) = total_label {
                out.push(row(RowStyle::GroupTotal, total_label, true));
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::tests::code;
    use crate::ledger::TbLine;
    use crate::mapping::tests::company_mapping;
    use crate::template::tests::{company_template, key};
    use proptest::prelude::*;

    fn tb(entries: &[(&str, i64)]) -> TrialBalance {
        entries
            .iter()
            .map(|&(c, cents)| TbLine {
                account: code(c),
                balance: Money::from_cents(cents),
            })
            .collect::<Vec<_>>()
            .into()
    }

    fn year(y: i32) -> ClientYear {
        ClientYear::new(
            NaiveDate::from_ymd_opt(y - 1, 4, 1).unwrap(),
            NaiveDate::from_ymd_opt(y, 3, 31).unwrap(),
        )
        .unwrap()
    }

    fn build(
        current: &TrialBalance,
        prior: Option<(&TrialBalance, bool)>,
        priority: &[&str],
    ) -> ReportDoc {
        let template = company_template();
        let mapping = company_mapping();
        let y = year(2026);
        let py = year(2025);
        let priority: Vec<AccountCode> = priority.iter().map(|c| code(c)).collect();
        build_report(&ReportInput {
            template: &template,
            mapping: &mapping,
            year: &y,
            tb: current,
            prior: prior.map(|(tb, finalised)| Prior {
                year: &py,
                tb,
                finalised,
            }),
            rounding_priority: &priority,
        })
        .unwrap()
    }

    fn find<'a>(doc: &'a ReportDoc, k: &str, style: RowStyle) -> &'a ReportRow {
        doc.statements
            .iter()
            .flat_map(|s| &s.rows)
            .find(|r| r.key.as_str() == k && r.style == style)
            .unwrap_or_else(|| panic!("no {style:?} row {k}"))
    }

    fn amount(doc: &ReportDoc, k: &str, style: RowStyle) -> i64 {
        find(doc, k, style).current.unwrap()
    }

    /// Accounts in the company mapping: 100 sales, 200 other income, 400 bank fees, 405 repairs,
    /// 410 other expenses, 600 bank, 620 receivables, 800 payables, 850 loans, 900 share capital,
    /// 950 retained earnings.
    #[test]
    fn profit_wins_and_the_priority_list_picks_bank_fees_when_there_is_no_rm() {
        // Income 100.40; expenses 50.60 (bank fees 30.30 + other 20.30); profit exactly 49.80,
        // all still in the bank.
        let current = tb(&[
            ("100", -10_040),
            ("400", 3_030),
            ("410", 2_030),
            ("600", 4_980),
        ]);
        let doc = build(&current, None, &["405", "400"]);
        assert_eq!(amount(&doc, "income", RowStyle::GroupTotal), 100);
        assert_eq!(amount(&doc, "net_profit", RowStyle::Total), 50);
        // Expenses round to 51 on their own, but give way to profit: 50.
        assert_eq!(amount(&doc, "expenses", RowStyle::GroupTotal), 50);
        // No R&M this year, so bank fees (30.30 → 30) absorbs both adjustments: +1 to bring
        // expenses to 51, then −1 so profit is 50.
        let bank_fees = find(&doc, "bank_fees", RowStyle::Line);
        let other = find(&doc, "other_expenses", RowStyle::Line);
        assert_eq!(bank_fees.current.unwrap() + other.current.unwrap(), 50);
        assert_eq!(other.current, Some(20));
        assert_eq!(bank_fees.current, Some(30));
        assert!(doc.warnings.is_empty(), "{:?}", doc.warnings);
        // Profit carries into equity as shown.
        assert_eq!(amount(&doc, "profit_for_year", RowStyle::Link), 50);
    }

    #[test]
    fn a_group_absorbs_through_the_priority_list() {
        // Three expense lines of 10.40: total 31.20 → 31, lines 10 each → bank fees takes the 1.
        let current = tb(&[
            ("400", 1_040),
            ("405", 1_040),
            ("410", 1_040),
            ("600", -3_120),
        ]);
        let doc = build(&current, None, &["400"]);
        assert_eq!(amount(&doc, "expenses", RowStyle::GroupTotal), 31);
        let bank_fees = find(&doc, "bank_fees", RowStyle::Line);
        assert_eq!(bank_fees.current, Some(11));
        assert_eq!(
            bank_fees.rounding,
            Some(RowRounding {
                current: 1,
                prior: 0
            })
        );
        // The drill-down still shows the real balance.
        assert_eq!(
            bank_fees.accounts,
            vec![RowAccount {
                code: code("400"),
                current: Money::from_cents(1_040),
                prior: Money::ZERO
            }]
        );
        assert!(doc.warnings.is_empty(), "{:?}", doc.warnings);
    }

    #[test]
    fn falls_back_to_the_largest_line_with_a_warning() {
        let current = tb(&[
            ("400", 1_040),
            ("405", 2_040),
            ("410", 1_040),
            ("600", -4_120),
        ]);
        let doc = build(&current, None, &[]);
        assert_eq!(find(&doc, "repairs", RowStyle::Line).current, Some(21));
        assert!(doc.warnings.contains(&ReportWarning::RoundingFallback {
            column: Column::Current,
            row: key("expenses"),
            line: key("repairs"),
        }));
    }

    #[test]
    fn balance_sheet_balances_and_liabilities_give_way() {
        // Assets 100.60 (→ 101), liabilities 30.40 (→ 30), equity and net assets 70.20 (→ 70).
        // 101 − 30 ≠ 70, so liabilities give way and show 31.
        let current = tb(&[("600", 10_060), ("800", -3_040), ("900", -7_020)]);
        let doc = build(&current, None, &["800"]);
        assert_eq!(amount(&doc, "assets", RowStyle::GroupTotal), 101);
        assert_eq!(amount(&doc, "equity", RowStyle::GroupTotal), 70);
        assert_eq!(amount(&doc, "net_assets", RowStyle::Total), 70);
        assert_eq!(amount(&doc, "liabilities", RowStyle::GroupTotal), 31);
        let payables = find(&doc, "payables", RowStyle::Line);
        assert_eq!(
            payables.rounding,
            Some(RowRounding {
                current: 1,
                prior: 0
            })
        );
        assert!(doc.warnings.is_empty(), "{:?}", doc.warnings);
    }

    #[test]
    fn comparatives_use_their_own_balances_and_flag_unfinalised() {
        let current = tb(&[("100", -10_000), ("600", 10_000)]);
        let prior = tb(&[("100", -5_000), ("600", 5_000)]);
        let doc = build(&current, Some((&prior, false)), &[]);
        assert_eq!(doc.comparatives, Comparatives::Unfinalised);
        assert_eq!(
            doc.prior_period.unwrap().end,
            NaiveDate::from_ymd_opt(2025, 3, 31).unwrap()
        );
        let sales = find(&doc, "sales", RowStyle::Line);
        assert_eq!((sales.current, sales.prior), (Some(100), Some(50)));
        let doc = build(&current, Some((&prior, true)), &[]);
        assert_eq!(doc.comparatives, Comparatives::Finalised);
        let doc = build(&current, None, &[]);
        assert_eq!(doc.comparatives, Comparatives::None);
        assert_eq!(find(&doc, "sales", RowStyle::Line).prior, None);
    }

    #[test]
    fn nil_lines_and_groups_are_left_out_but_totals_stay() {
        let current = tb(&[("100", -10_000), ("600", 10_000)]);
        let doc = build(&current, None, &[]);
        let keys: Vec<(&str, RowStyle)> = doc.statements[0]
            .rows
            .iter()
            .map(|r| (r.key.as_str(), r.style))
            .collect();
        assert_eq!(
            keys,
            [
                ("income", RowStyle::Heading),
                ("sales", RowStyle::Line),
                ("income", RowStyle::GroupTotal),
                ("net_profit", RowStyle::Total),
            ]
        );
    }

    #[test]
    fn rejects_unbalanced_tbs_and_unmapped_accounts() {
        let template = company_template();
        let mapping = company_mapping();
        let y = year(2026);
        let run = |tb: &TrialBalance| {
            build_report(&ReportInput {
                template: &template,
                mapping: &mapping,
                year: &y,
                tb,
                prior: None,
                rounding_priority: &[],
            })
            .unwrap_err()
        };
        assert_eq!(
            run(&tb(&[("100", -100), ("600", 99)])),
            vec![BuildError::UnbalancedTb {
                column: Column::Current,
                difference: Money::from_cents(-1)
            }]
        );
        assert_eq!(
            run(&tb(&[("100", -100), ("700", 100)])),
            vec![BuildError::Mapping(MappingError::Unmapped {
                account: code("700")
            })]
        );
    }

    #[test]
    fn json_is_byte_stable() {
        let current = tb(&[
            ("100", -10_040),
            ("400", 3_030),
            ("410", 2_030),
            ("600", 4_980),
        ]);
        let a = serde_json::to_string(&build(&current, None, &["400"])).unwrap();
        let b = serde_json::to_string(&build(&current, None, &["400"])).unwrap();
        assert_eq!(a, b);
    }

    const CODES: [&str; 11] = [
        "100", "200", "400", "405", "410", "600", "620", "800", "850", "900", "950",
    ];

    /// A random balanced TB over the company accounts.
    fn arb_tb() -> impl Strategy<Value = TrialBalance> {
        proptest::collection::vec(-5_000_000i64..5_000_000, CODES.len() - 1).prop_map(|amounts| {
            let total: i64 = amounts.iter().sum();
            let mut entries: Vec<(&str, i64)> = CODES.iter().copied().zip(amounts).collect();
            entries.push(("950", -total));
            tb(&entries)
        })
    }

    fn arb_priority() -> impl Strategy<Value = Vec<&'static str>> {
        proptest::sample::subsequence(CODES.to_vec(), 0..CODES.len()).prop_shuffle()
    }

    proptest! {
        #[test]
        fn statements_always_foot_and_balance(current in arb_tb(), prior in arb_tb(), priority in arb_priority()) {
            let doc = build(&current, Some((&prior, true)), &priority);
            prop_assert!(doc.warnings.iter().all(|w| matches!(w, ReportWarning::RoundingFallback { .. })), "{:?}", doc.warnings);
            let exact = |tb: &TrialBalance, codes: &[&str]| -> i64 {
                codes.iter().map(|c| tb.balance(&code(c)).cents()).sum()
            };
            for (col, tb) in [(0usize, &current), (1, &prior)] {
                // A row that's left out shows zero in both columns.
                let get = |k: &str, s: RowStyle| {
                    let row = doc.statements.iter().flat_map(|st| &st.rows).find(|r| r.key.as_str() == k && r.style == s);
                    row.map_or(0, |r| if col == 0 { r.current.unwrap() } else { r.prior.unwrap() })
                };
                // Protected totals equal their exact totals, rounded.
                let profit_exact = -exact(tb, &["100", "200", "400", "405", "410"]);
                prop_assert_eq!(get("net_profit", RowStyle::Total), round_cents(profit_exact));
                prop_assert_eq!(get("assets", RowStyle::GroupTotal), round_cents(exact(tb, &["600", "620"])));
                // The balance sheet balances, and profit in equity equals the P&L's.
                prop_assert_eq!(get("net_assets", RowStyle::Total), get("equity", RowStyle::GroupTotal));
                prop_assert_eq!(get("profit_for_year", RowStyle::Link), get("net_profit", RowStyle::Total));
                // Every group foots: its total equals the sum of the rows directly inside it.
                for statement in &doc.statements {
                    let rows = &statement.rows;
                    for (i, r) in rows.iter().enumerate().filter(|(_, r)| r.style == RowStyle::Heading) {
                        let end = rows[i..].iter().position(|t| t.key == r.key && t.style == RowStyle::GroupTotal).unwrap() + i;
                        let sign = |row: &ReportRow| {
                            let node = company_template().find(&row.key).cloned().unwrap();
                            let p = presentation_of(&node);
                            let v = if col == 0 { row.current } else { row.prior };
                            p.apply(v.unwrap_or(0))
                        };
                        let inner: i64 = rows[i + 1..end]
                            .iter()
                            .filter(|c| c.depth == r.depth + 1 && c.style != RowStyle::Heading)
                            .map(sign)
                            .sum();
                        prop_assert_eq!(inner, sign(&rows[end]));
                    }
                }
            }
            // Mapped totals equal TB totals: every account shows under its line with its real
            // balance, unless the whole line is left out for showing zero.
            let mapping = company_mapping();
            for (account, balance) in current.iter() {
                let line = mapping.line_for(account).unwrap();
                let row = doc.statements.iter().flat_map(|s| &s.rows).find(|r| &r.key == line);
                if let Some(row) = row {
                    let node = company_template().find(line).cloned().unwrap();
                    let shown = row.accounts.iter().find(|a| &a.code == account).unwrap();
                    prop_assert_eq!(presentation_of(&node).apply(shown.current.cents()), balance.cents());
                }
            }
        }
    }
}
