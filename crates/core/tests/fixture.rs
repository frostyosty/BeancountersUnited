//! Builds the synthetic fixture company's statements from `fixtures/` and snapshots them.
//!
//! The fixture files are read at compile time, so the core crate still does no IO at runtime.

use std::collections::BTreeMap;

use acct_core::{
    Account, AccountCode, Asset, AssetAccounts, AssetYear, Chart, ClientYear, DepreciationSettings,
    Journal, Mapping, Money, Prior, RegisterAsset, ReportDoc, ReportInput, RowStyle, ScheduleClass,
    Template, TrialBalance, asset_years, build_asset_schedule, build_report, reconcile, rollover,
    year_journals,
};
use chrono::NaiveDate;
use serde::Deserialize;

const CHART: &str = include_str!("../../../fixtures/practice/company-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/company-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/company-mapping.json");
const CLIENT: &str = include_str!("../../../fixtures/clients/example-widgets.json");
const ASSET_CLASSES: &str = include_str!("../../../fixtures/practice/company-asset-classes.json");

#[derive(Deserialize)]
struct Client {
    name: String,
    retained_earnings: AccountCode,
    rounding_priority: Vec<AccountCode>,
    assets: Vec<FixtureAsset>,
    years: Vec<Year>,
}

#[derive(Deserialize)]
struct AssetClass {
    key: String,
    name: String,
    settings: DepreciationSettings,
    accounts: AssetAccounts,
}

#[derive(Deserialize)]
struct FixtureAsset {
    class: String,
    name: String,
    cost: Money,
    residual: Money,
    acquired: NaiveDate,
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
    register: Vec<RegisterAsset>,
    /// Each asset's movements, per year.
    movements: Vec<Vec<AssetYear>>,
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

    // The register, with each asset's class settings and accounts copied onto it.
    let classes: Vec<AssetClass> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let register: Vec<RegisterAsset> = client
        .assets
        .iter()
        .map(|a| {
            let class = classes.iter().find(|c| c.key == a.class).unwrap();
            RegisterAsset {
                name: a.name.clone(),
                class: class.key.clone(),
                accounts: class.accounts.clone(),
                asset: Asset {
                    cost: a.cost,
                    residual: a.residual,
                    acquired: a.acquired,
                    settings: class.settings,
                    opening: None,
                    disposal: None,
                },
            }
        })
        .collect();
    let client_years: Vec<ClientYear> = client
        .years
        .iter()
        .map(|y| ClientYear::new(y.start, y.end).unwrap())
        .collect();
    let movements: Vec<Vec<AssetYear>> = register
        .iter()
        .map(|a| asset_years(&a.asset, &client_years, &BTreeMap::new()).unwrap())
        .collect();
    let year_rows = |i: usize| -> Vec<AssetYear> { movements.iter().map(|m| m[i]).collect() };

    let mut years: Vec<(ClientYear, TrialBalance)> = Vec::new();
    for (i, y) in client.years.iter().enumerate() {
        let year = client_years[i];
        // The year's own journals, then the register's depreciation and disposal journals.
        let mut journals = y.journals.clone();
        journals.extend(
            year_journals(&year, &register, &year_rows(i))
                .all()
                .cloned(),
        );
        for journal in &journals {
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
        let closing = TrialBalance::from_journals(&opening, &journals);
        assert!(closing.is_balanced());
        years.push((year, closing));
    }

    let schedule_classes: Vec<ScheduleClass> = classes
        .iter()
        .map(|c| ScheduleClass {
            code: c.key.clone(),
            name: c.name.clone(),
        })
        .collect();
    let docs = (0..years.len())
        .map(|i| {
            let (year, tb) = &years[i];
            let prior = i.checked_sub(1).map(|p| Prior {
                year: &years[p].0,
                tb: &years[p].1,
                finalised: true,
            });
            let mut doc = build_report(&ReportInput {
                template: &template,
                mapping: &mapping,
                year,
                tb,
                prior,
                rounding_priority: &client.rounding_priority,
            })
            .unwrap();
            let prior_rows = i.checked_sub(1).map(year_rows);
            doc.asset_schedule = Some(build_asset_schedule(
                &schedule_classes,
                &register,
                &year_rows(i),
                prior_rows.as_deref(),
            ));
            doc
        })
        .collect();
    Built {
        years,
        docs,
        register,
        movements,
    }
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
    if let Some(schedule) = &doc.asset_schedule {
        out.push_str(&format!("{}\n", schedule.title));
        for block in &schedule.blocks {
            out.push_str(&format!("  {}\n", block.title));
            for row in &block.rows {
                out.push_str(&format!(
                    "    {:<48}{:>12}{:>12}\n",
                    row.label,
                    fmt(row.current),
                    fmt(row.prior)
                ));
            }
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

/// M4's done check: the register's closing cost and accumulated depreciation equal the ledger
/// accounts behind the balance sheet, in every year, and the schedule's book value equals the
/// balance sheet's property, plant and equipment line.
#[test]
fn fixture_register_reconciles_to_the_balance_sheet() {
    let built = build();
    for (i, (year, tb)) in built.years.iter().enumerate() {
        let rows: Vec<AssetYear> = built.movements.iter().map(|m| m[i]).collect();
        for line in reconcile(&built.register, &rows, tb) {
            assert_eq!(
                line.difference(),
                Money::ZERO,
                "{} at {}",
                line.account,
                year.end()
            );
        }
        let doc = &built.docs[i];
        let schedule = doc.asset_schedule.as_ref().unwrap();
        let total = schedule.blocks.last().unwrap();
        let book_value = total
            .rows
            .iter()
            .find(|r| r.key == acct_core::ScheduleRowKey::BookValue)
            .unwrap()
            .current;
        let ppe = doc
            .statements
            .iter()
            .flat_map(|s| &s.rows)
            .find(|r| r.key.as_str() == "ppe")
            .unwrap()
            .current;
        assert_eq!(book_value, ppe, "{}", year.end());
    }
}
