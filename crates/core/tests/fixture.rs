//! Builds the synthetic fixture company's statements from `fixtures/` and snapshots them.
//!
//! The fixture files are read at compile time, so the core crate still does no IO at runtime.

use acct_core::{
    Account, AccountCode, Chart, ClientYear, Journal, Mapping, Prior, ReportDoc, ReportInput,
    RowStyle, Template, TrialBalance, build_report, rollover,
};
use chrono::NaiveDate;
use serde::Deserialize;

const CHART: &str = include_str!("../../../fixtures/practice/company-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/company-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/company-mapping.json");
const CLIENT: &str = include_str!("../../../fixtures/clients/example-widgets.json");

#[derive(Deserialize)]
struct Client {
    name: String,
    retained_earnings: AccountCode,
    rounding_priority: Vec<AccountCode>,
    years: Vec<Year>,
}

#[derive(Deserialize)]
struct Year {
    start: NaiveDate,
    end: NaiveDate,
    journals: Vec<Journal>,
}

struct Built {
    years: Vec<(ClientYear, TrialBalance)>,
    docs: Vec<ReportDoc>,
}

fn build() -> Built {
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    let chart = Chart::new(accounts).unwrap();
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    let client: Client = serde_json::from_str(CLIENT).unwrap();
    assert_eq!(client.name, "Example Widgets Limited");
    template.validate().unwrap();
    mapping.validate(&template).unwrap();

    let mut years: Vec<(ClientYear, TrialBalance)> = Vec::new();
    for y in &client.years {
        let year = ClientYear::new(y.start, y.end).unwrap();
        for journal in &y.journals {
            journal
                .validate(&chart, &year)
                .unwrap_or_else(|e| panic!("{}: {e:?}", journal.narration));
        }
        let opening = match years.last() {
            Some((_, prior_closing)) => {
                rollover(prior_closing, &chart, &client.retained_earnings).unwrap()
            }
            None => TrialBalance::default(),
        };
        let closing = TrialBalance::from_journals(&opening, &y.journals);
        assert!(closing.is_balanced());
        years.push((year, closing));
    }

    let docs = (0..years.len())
        .map(|i| {
            let (year, tb) = &years[i];
            let prior = i.checked_sub(1).map(|p| Prior {
                year: &years[p].0,
                tb: &years[p].1,
                finalised: true,
            });
            build_report(&ReportInput {
                template: &template,
                mapping: &mapping,
                year,
                tb,
                prior,
                rounding_priority: &client.rounding_priority,
            })
            .unwrap()
        })
        .collect();
    Built { years, docs }
}

/// A plain-text rendering for people to review alongside the JSON snapshot. Not a product
/// renderer: the real ones (HTML, PDF) come later and only render the ReportDoc.
fn render_text(doc: &ReportDoc) -> String {
    let mut out = String::new();
    let fmt = |v: Option<i64>| match v {
        None => String::new(),
        Some(v) if v < 0 => format!("({})", group_thousands(-v)),
        Some(v) => group_thousands(v),
    };
    for statement in &doc.statements {
        out.push_str(&format!("{}\n", statement.title));
        out.push_str(&format!(
            "{:<48}{:>12}{:>12}\n",
            "",
            doc.current_period.end.format("%Y").to_string(),
            doc.prior_period
                .map(|p| p.end.format("%Y").to_string())
                .unwrap_or_default()
        ));
        for row in &statement.rows {
            let indent = "  ".repeat(usize::from(row.depth));
            let mark = match row.style {
                RowStyle::GroupTotal | RowStyle::Total => "=",
                _ => " ",
            };
            let label = format!("{mark}{indent}{}", row.label);
            let note = match row.rounding {
                Some(r) => format!("  [rounding {:+} / {:+}]", r.current, r.prior),
                None => String::new(),
            };
            out.push_str(&format!(
                "{label:<48}{:>12}{:>12}{note}\n",
                fmt(row.current),
                fmt(row.prior)
            ));
        }
        out.push('\n');
    }
    for w in &doc.warnings {
        out.push_str(&format!("warning: {w:?}\n"));
    }
    out
}

fn group_thousands(v: i64) -> String {
    let s = v.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[test]
fn fixture_trial_balances() {
    let built = build();
    let tbs: Vec<String> = built
        .years
        .iter()
        .map(|(year, tb)| {
            let mut s = format!("Closing TB at {}\n", year.end());
            for (code, balance) in tb.iter() {
                s.push_str(&format!("{:<8}{:>16}\n", code, balance.to_string()));
            }
            s
        })
        .collect();
    insta::assert_snapshot!("trial_balances", tbs.join("\n"));
}

#[test]
fn fixture_statements_json() {
    let built = build();
    insta::assert_snapshot!(
        "fy2025_reportdoc",
        serde_json::to_string_pretty(&built.docs[0]).unwrap()
    );
    insta::assert_snapshot!(
        "fy2026_reportdoc",
        serde_json::to_string_pretty(&built.docs[1]).unwrap()
    );
}

#[test]
fn fixture_statements_text() {
    let built = build();
    insta::assert_snapshot!("fy2025_text", render_text(&built.docs[0]));
    insta::assert_snapshot!("fy2026_text", render_text(&built.docs[1]));
}

#[test]
fn fixture_reportdoc_is_byte_stable() {
    let a = serde_json::to_string(&build().docs[1]).unwrap();
    let b = serde_json::to_string(&build().docs[1]).unwrap();
    assert_eq!(a, b);
}
