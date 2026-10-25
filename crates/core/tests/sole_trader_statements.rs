//! The synthetic sole trader's statements after Save tax (M15): the P&L and balance sheet built
//! from the ledger the M11 coding fixture gives, snapshotted, with the totals of the worked
//! example in `docs/domain.md` ("Worked example: the sole trader's statements").
//!
//! The ledger is the fixture's `expected.tb`. `crates/server/tests/m11.rs` checks that coding the
//! statements through the command pipeline gives exactly that TB. The fixture files are read at
//! compile time, so the core crate still does no IO at runtime.

use acct_core::{
    Account, AccountCode, AccountType, Chart, ClientYear, Comparatives, Mapping, Money, ReportDoc,
    ReportInput, RowStyle, Template, TrialBalance, build_report,
};
use chrono::NaiveDate;
use serde_json::Value;

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ROUNDING: &str =
    include_str!("../../../fixtures/practice/sole-trader-rounding-priority.json");
const CODING: &str = include_str!("../../../fixtures/clients/marsh-hollow-coding.json");

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

/// The ledger after coding, as a trial balance.
fn tb() -> TrialBalance {
    let fixture: Value = serde_json::from_str(CODING).unwrap();
    let mut tb = TrialBalance::default();
    for (code, cents) in fixture["expected"]["tb"].as_object().unwrap() {
        let code: AccountCode = code.parse().unwrap();
        tb.post(&code, Money::from_cents(cents.as_i64().unwrap()));
    }
    tb
}

fn build() -> ReportDoc {
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    let rounding: Vec<AccountCode> = serde_json::from_str(ROUNDING).unwrap();
    // The first client-year starts on the business start date (`docs/domain.md`, "Bank
    // statements to the ledger"), so there's no prior year.
    let year = ClientYear::new(d("2025-08-01"), d("2026-03-31")).unwrap();
    let tb = tb();
    assert!(tb.is_balanced());
    // Every account in the TB is in the business's chart: the master chart, plus one asset
    // account per bank account, as `add_bank_account` adds them.
    let fixture: Value = serde_json::from_str(CODING).unwrap();
    let mut accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    for (i, bank) in fixture["business"]["bank_accounts"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        assert_eq!(bank["code"].as_str().unwrap(), format!("600.{:02}", i + 1));
        accounts.push(Account {
            code: bank["code"].as_str().unwrap().parse().unwrap(),
            name: bank["name"].as_str().unwrap().to_owned(),
            account_type: AccountType::Asset,
            active: true,
            default_gst: None,
        });
    }
    let chart = Chart::new(accounts).unwrap();
    for (code, _) in tb.iter() {
        assert!(chart.get(code).is_some(), "{code} isn't in the chart");
    }
    build_report(&ReportInput {
        template: &template,
        mapping: &mapping,
        year: &year,
        tb: &tb,
        prior: None,
        rounding_priority: &rounding,
    })
    .unwrap()
}

/// A row's current-year amount, by key. A group's amount is on its total, not its heading.
fn current(doc: &ReportDoc, key: &str) -> Option<i64> {
    doc.statements
        .iter()
        .flat_map(|s| &s.rows)
        .find(|r| r.key.as_str() == key && r.style != RowStyle::Heading)
        .unwrap_or_else(|| panic!("no row {key}"))
        .current
}

fn has_row(doc: &ReportDoc, key: &str) -> bool {
    doc.statements
        .iter()
        .flat_map(|s| &s.rows)
        .any(|r| r.key.as_str() == key)
}

#[test]
fn sole_trader_reportdoc() {
    insta::assert_snapshot!(
        "sole_trader_reportdoc",
        serde_json::to_string_pretty(&build()).unwrap()
    );
}

/// The worked example's figures, whole dollars.
#[test]
fn sole_trader_totals_match_the_worked_example() {
    let doc = build();
    let want = [
        // Statement of Financial Performance
        ("sales", 2_626),
        ("interest_income", 4),
        ("unsorted_income", 330),
        ("income", 2_960),
        ("purchases", 346),
        ("gross_profit", 2_614),
        ("insurance", 187),
        ("rent", 39),
        ("phone_internet", 18), // 17 plus the expenses' $1 of rounding
        ("power_gas", 26),
        ("freight", 119),
        ("stationery", 66),
        ("software", 43),
        ("small_tools", 104),
        ("expenses", 602),
        ("net_profit", 2_012),
        // Statement of Financial Position
        ("bank", 6_232),
        ("gst_to_claim", 28),
        ("current_assets", 6_260),
        ("assets", 6_260),
        ("gst", 330), // 329 plus the current liabilities' $1 of rounding
        ("gst_refunds", 163),
        ("current_liabilities", 493),
        ("liabilities", 493),
        ("net_assets", 5_767),
        ("capital", 4_550),
        ("profit_for_year", 2_012),
        ("drawings", -795),
        ("equity", 5_767),
    ];
    for (key, amount) in want {
        assert_eq!(current(&doc, key), Some(amount), "{key}");
    }
    // A first year: no prior column at all.
    assert_eq!(doc.comparatives, Comparatives::None);
    assert!(doc.prior_period.is_none());
    for row in doc.statements.iter().flat_map(|s| &s.rows) {
        assert_eq!(row.prior, None, "{}", row.key.as_str());
    }
    // Nil lines and all-nil groups are left out ("Nil lines" in docs/domain.md).
    for key in [
        "other_income",
        "opening_equity",
        "non_current_assets",
        "non_current_liabilities",
        "unsorted_money_out",
    ] {
        assert!(!has_row(&doc, key), "{key} should be left out");
    }
    // Both roundings went to lines on the priority list (245 for expenses, 810 for current
    // liabilities), so there's no fallback warning.
    assert!(doc.warnings.is_empty(), "{:?}", doc.warnings);
}

#[test]
fn sole_trader_reportdoc_is_byte_stable() {
    let a = serde_json::to_string(&build()).unwrap();
    let b = serde_json::to_string(&build()).unwrap();
    assert_eq!(a, b);
}
