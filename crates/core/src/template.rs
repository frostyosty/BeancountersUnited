//! Statement templates: the layout of report lines that mappings point accounts at.
//!
//! Every row's amount is held in ledger sign (debits positive). A row's [`Presentation`] only
//! decides whether it's shown as is or negated, so totals are plain sums and the same numbers
//! can be checked against each other regardless of how they're displayed.

use std::collections::BTreeSet;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

/// A stable key for a template row, such as `revenue` or `total_equity`. Lowercase ASCII letters,
/// digits, `_`, `-` and `.`. Mappings and ReportDocs refer to rows by key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(try_from = "String", into = "String")]
#[ts(export, as = "String")]
pub struct LineKey(String);

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("'{0}' isn't a valid line key: use 1-64 lowercase letters, digits, '_', '-' or '.'")]
pub struct LineKeyError(pub String);

impl LineKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for LineKey {
    type Err = LineKeyError;
    fn from_str(s: &str) -> Result<LineKey, LineKeyError> {
        let ok = (1..=64).contains(&s.len())
            && s.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-' | b'.')
            });
        if ok {
            Ok(LineKey(s.to_owned()))
        } else {
            Err(LineKeyError(s.to_owned()))
        }
    }
}

impl TryFrom<String> for LineKey {
    type Error = LineKeyError;
    fn try_from(s: String) -> Result<LineKey, LineKeyError> {
        s.parse()
    }
}

impl From<LineKey> for String {
    fn from(key: LineKey) -> String {
        key.0
    }
}

impl fmt::Display for LineKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How a row's ledger-sign amount is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Presentation {
    /// Shown as is: a debit balance is positive. Assets, expenses.
    DebitPositive,
    /// Negated: a credit balance is positive. Income, liabilities, equity, profit.
    CreditPositive,
}

impl Presentation {
    /// Converts a ledger-sign value to the value shown (or back: the conversion is its own inverse).
    pub const fn apply(self, value: i64) -> i64 {
        match self {
            Presentation::DebitPositive => value,
            Presentation::CreditPositive => -value,
        }
    }
}

/// A row in a statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Node {
    /// A heading over child rows. Its amount is the sum of its children. With `total_label` set, a
    /// total row is shown after the children.
    Group {
        key: LineKey,
        label: String,
        presentation: Presentation,
        children: Vec<Node>,
        total_label: Option<String>,
        /// Set on key totals that rounding must keep equal to their exact total, rounded. Lower
        /// numbers win when protected totals conflict. See `docs/domain.md`.
        protect: Option<u8>,
    },
    /// A row that accounts are mapped to.
    Line {
        key: LineKey,
        label: String,
        presentation: Presentation,
    },
    /// The sum of earlier rows, such as net profit = income + expenses.
    Total {
        key: LineKey,
        label: String,
        presentation: Presentation,
        of: Vec<LineKey>,
        protect: Option<u8>,
    },
    /// Repeats an earlier row's figure, such as profit for the year inside equity.
    Link {
        key: LineKey,
        label: String,
        presentation: Presentation,
        from: LineKey,
    },
}

impl Node {
    pub fn key(&self) -> &LineKey {
        match self {
            Node::Group { key, .. }
            | Node::Line { key, .. }
            | Node::Total { key, .. }
            | Node::Link { key, .. } => key,
        }
    }

    /// This node and all its descendants, in document order.
    pub fn walk(&self) -> Vec<&Node> {
        let mut out = vec![self];
        if let Node::Group { children, .. } = self {
            for child in children {
                out.extend(child.walk());
            }
        }
        out
    }
}

/// One statement, such as the statement of financial performance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Statement {
    pub key: LineKey,
    pub title: String,
    pub body: Vec<Node>,
}

/// Two rows whose shown amounts must agree after rounding, such as net assets and total equity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EqualityCheck {
    pub left: LineKey,
    pub right: LineKey,
}

/// A set of statements for one entity type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Template {
    pub name: String,
    pub statements: Vec<Statement>,
    pub checks: Vec<EqualityCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TemplateError {
    #[error("the key {0} is used more than once")]
    DuplicateKey(LineKey),
    #[error("{node} refers to {target}, which doesn't come earlier in the template")]
    UnknownReference { node: LineKey, target: LineKey },
    #[error("the total {0} doesn't add up anything")]
    EmptyTotal(LineKey),
    #[error("the check refers to {0}, which isn't in the template")]
    UnknownCheckKey(LineKey),
}

impl Template {
    /// Every node in document order, across statements.
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.statements
            .iter()
            .flat_map(|s| s.body.iter().flat_map(Node::walk))
    }

    pub fn find(&self, key: &LineKey) -> Option<&Node> {
        self.nodes().find(|n| n.key() == key)
    }

    /// Checks that keys are unique across the template (statement keys included), that totals and
    /// links only refer to rows that come earlier (so there can be no cycles), and that checks
    /// refer to existing rows.
    pub fn validate(&self) -> Result<(), Vec<TemplateError>> {
        let mut errors = Vec::new();
        let mut seen: BTreeSet<&LineKey> = BTreeSet::new();
        for statement in &self.statements {
            if !seen.insert(&statement.key) {
                errors.push(TemplateError::DuplicateKey(statement.key.clone()));
            }
        }
        for statement in &self.statements {
            for top in &statement.body {
                validate_node(top, &mut seen, &mut errors);
            }
        }
        for check in &self.checks {
            for key in [&check.left, &check.right] {
                if !seen.contains(key) {
                    errors.push(TemplateError::UnknownCheckKey(key.clone()));
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

fn validate_node<'a>(
    node: &'a Node,
    seen: &mut BTreeSet<&'a LineKey>,
    errors: &mut Vec<TemplateError>,
) {
    // Children come before their group's own key is "seen": a group total can't be referred to
    // from inside itself.
    if let Node::Group { children, .. } = node {
        for child in children {
            validate_node(child, seen, errors);
        }
    }
    let refs: &[LineKey] = match node {
        Node::Total { of, .. } => {
            if of.is_empty() {
                errors.push(TemplateError::EmptyTotal(node.key().clone()));
            }
            of
        }
        Node::Link { from, .. } => std::slice::from_ref(from),
        _ => &[],
    };
    for target in refs {
        if !seen.contains(target) {
            errors.push(TemplateError::UnknownReference {
                node: node.key().clone(),
                target: target.clone(),
            });
        }
    }
    if !seen.insert(node.key()) {
        errors.push(TemplateError::DuplicateKey(node.key().clone()));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use Presentation::*;

    pub fn key(s: &str) -> LineKey {
        s.parse().unwrap()
    }

    pub fn line(k: &str, label: &str, presentation: Presentation) -> Node {
        Node::Line {
            key: key(k),
            label: label.to_owned(),
            presentation,
        }
    }

    pub fn group(
        k: &str,
        label: &str,
        p: Presentation,
        total: Option<&str>,
        protect: Option<u8>,
        children: Vec<Node>,
    ) -> Node {
        Node::Group {
            key: key(k),
            label: label.to_owned(),
            presentation: p,
            children,
            total_label: total.map(str::to_owned),
            protect,
        }
    }

    pub fn total(k: &str, label: &str, p: Presentation, of: &[&str], protect: Option<u8>) -> Node {
        Node::Total {
            key: key(k),
            label: label.to_owned(),
            presentation: p,
            of: of.iter().map(|s| key(s)).collect(),
            protect,
        }
    }

    pub fn link(k: &str, label: &str, p: Presentation, from: &str) -> Node {
        Node::Link {
            key: key(k),
            label: label.to_owned(),
            presentation: p,
            from: key(from),
        }
    }

    /// A small company template used across core tests. Our own wording.
    pub fn company_template() -> Template {
        Template {
            name: "Company".to_owned(),
            statements: vec![
                Statement {
                    key: key("performance"),
                    title: "Statement of Financial Performance".to_owned(),
                    body: vec![
                        group(
                            "income",
                            "Income",
                            CreditPositive,
                            Some("Total income"),
                            None,
                            vec![
                                line("sales", "Sales", CreditPositive),
                                line("other_income", "Other income", CreditPositive),
                            ],
                        ),
                        group(
                            "expenses",
                            "Expenses",
                            DebitPositive,
                            Some("Total expenses"),
                            None,
                            vec![
                                line("bank_fees", "Bank fees", DebitPositive),
                                line("repairs", "Repairs and maintenance", DebitPositive),
                                line("other_expenses", "Other expenses", DebitPositive),
                            ],
                        ),
                        total(
                            "net_profit",
                            "Net profit",
                            CreditPositive,
                            &["income", "expenses"],
                            Some(1),
                        ),
                    ],
                },
                Statement {
                    key: key("position"),
                    title: "Statement of Financial Position".to_owned(),
                    body: vec![
                        group(
                            "assets",
                            "Assets",
                            DebitPositive,
                            Some("Total assets"),
                            Some(2),
                            vec![
                                line("bank", "Bank", DebitPositive),
                                line("receivables", "Receivables", DebitPositive),
                            ],
                        ),
                        group(
                            "liabilities",
                            "Liabilities",
                            CreditPositive,
                            Some("Total liabilities"),
                            None,
                            vec![
                                line("payables", "Payables", CreditPositive),
                                line("loans", "Loans", CreditPositive),
                            ],
                        ),
                        total(
                            "net_assets",
                            "Net assets",
                            DebitPositive,
                            &["assets", "liabilities"],
                            None,
                        ),
                        group(
                            "equity",
                            "Equity",
                            CreditPositive,
                            Some("Total equity"),
                            Some(3),
                            vec![
                                line("share_capital", "Share capital", CreditPositive),
                                line("retained_earnings", "Retained earnings", CreditPositive),
                                link(
                                    "profit_for_year",
                                    "Profit for the year",
                                    CreditPositive,
                                    "net_profit",
                                ),
                            ],
                        ),
                    ],
                },
            ],
            checks: vec![EqualityCheck {
                left: key("net_assets"),
                right: key("equity"),
            }],
        }
    }

    #[test]
    fn line_keys() {
        assert!("total_equity".parse::<LineKey>().is_ok());
        assert!("a.b-c_1".parse::<LineKey>().is_ok());
        for bad in ["", "Revenue", "net profit", "x".repeat(65).as_str()] {
            assert!(bad.parse::<LineKey>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn presentation_flips_credit_positive_rows() {
        assert_eq!(DebitPositive.apply(-5), -5);
        assert_eq!(CreditPositive.apply(-5), 5);
    }

    #[test]
    fn company_template_is_valid() {
        let t = company_template();
        assert_eq!(t.validate(), Ok(()));
        let keys: Vec<&str> = t.nodes().map(|n| n.key().as_str()).take(4).collect();
        assert_eq!(keys, ["income", "sales", "other_income", "expenses"]);
        assert!(matches!(
            t.find(&key("profit_for_year")),
            Some(Node::Link { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_keys() {
        let mut t = company_template();
        t.statements[1]
            .body
            .push(line("sales", "Sales again", CreditPositive));
        assert_eq!(
            t.validate(),
            Err(vec![TemplateError::DuplicateKey(key("sales"))])
        );

        let mut t = company_template();
        t.statements[1].key = key("performance");
        assert_eq!(
            t.validate(),
            Err(vec![TemplateError::DuplicateKey(key("performance"))])
        );
    }

    #[test]
    fn rejects_forward_self_and_unknown_references() {
        let mut t = company_template();
        // Refers to a later row.
        t.statements[0].body.insert(
            0,
            total("early", "Early", CreditPositive, &["income"], None),
        );
        // Refers to its own group from inside it.
        if let Node::Group { children, .. } = &mut t.statements[1].body[3] {
            children.push(link("loop", "Loop", CreditPositive, "equity"));
        }
        t.statements[1]
            .body
            .push(link("nowhere", "Nowhere", DebitPositive, "missing"));
        t.statements[1]
            .body
            .push(total("empty", "Empty", DebitPositive, &[], None));
        t.checks.push(EqualityCheck {
            left: key("bank"),
            right: key("ghost"),
        });
        assert_eq!(
            t.validate(),
            Err(vec![
                TemplateError::UnknownReference {
                    node: key("early"),
                    target: key("income")
                },
                TemplateError::UnknownReference {
                    node: key("loop"),
                    target: key("equity")
                },
                TemplateError::UnknownReference {
                    node: key("nowhere"),
                    target: key("missing")
                },
                TemplateError::EmptyTotal(key("empty")),
                TemplateError::UnknownCheckKey(key("ghost")),
            ])
        );
    }

    #[test]
    fn json_shape() {
        let json = serde_json::to_string(&line("sales", "Sales", CreditPositive)).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"line","key":"sales","label":"Sales","presentation":"credit_positive"}"#
        );
        let t = company_template();
        let back: Template = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(back, t);
    }
}
