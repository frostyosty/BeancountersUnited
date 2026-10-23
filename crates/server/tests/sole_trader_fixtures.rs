//! The sole-trader practice defaults in `fixtures/practice/sole-trader-*.json` (docs/domain.md,
//! "Sole-trader chart and template"): they parse, pass core's validation, build a ReportDoc, and
//! are accepted by the command pipeline.

use acct_core::{
    Account, AccountCode, AccountType, AssetAccounts, Chart, ClientYear, DepreciationSettings,
    Mapping, Money, Node, ReportInput, Template, TrialBalance, build_report,
};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_store::Store;
use acct_store::users::Role;
use chrono::{NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ASSET_CLASSES: &str =
    include_str!("../../../fixtures/practice/sole-trader-asset-classes.json");
const ROUNDING_PRIORITY: &str =
    include_str!("../../../fixtures/practice/sole-trader-rounding-priority.json");
const CODING_SETTINGS: &str =
    include_str!("../../../fixtures/practice/sole-trader-coding-settings.json");

#[derive(Deserialize)]
struct AssetClass {
    key: String,
    name: String,
    settings: DepreciationSettings,
    accounts: AssetAccounts,
}

struct Defaults {
    accounts: Vec<Account>,
    chart: Chart,
    template: Template,
    mapping: Mapping,
    classes: Vec<AssetClass>,
    priority: Vec<AccountCode>,
}

fn defaults() -> Defaults {
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    Defaults {
        chart: Chart::new(accounts.clone()).unwrap(),
        accounts,
        template: serde_json::from_str(TEMPLATE).unwrap(),
        mapping: serde_json::from_str(MAPPING).unwrap(),
        classes: serde_json::from_str(ASSET_CLASSES).unwrap(),
        priority: serde_json::from_str(ROUNDING_PRIORITY).unwrap(),
    }
}

fn code(s: &str) -> AccountCode {
    s.parse().unwrap()
}

fn key(s: &str) -> acct_core::LineKey {
    s.parse().unwrap()
}

/// The line keys inside one statement of the template.
fn statement_lines(template: &Template, statement: &str) -> Vec<acct_core::LineKey> {
    template
        .statements
        .iter()
        .find(|s| s.key == key(statement))
        .unwrap()
        .body
        .iter()
        .flat_map(Node::walk)
        .filter(|n| matches!(n, Node::Line { .. }))
        .map(|n| n.key().clone())
        .collect()
}

/// Bank accounts (600.xx), credit cards (850.xx) and vehicle sub-accounts (225.xx) are added per
/// client, so they aren't in the master chart, but the mapping must still place them.
const CLIENT_ADDED: [(&str, &str); 3] = [
    ("600.01", "bank"),
    ("850.01", "credit_cards"),
    ("225.01", "vehicle"),
];

#[test]
fn chart_template_and_mapping_validate() {
    let d = defaults();
    d.template.validate().unwrap();
    d.mapping.validate(&d.template).unwrap();

    // The holding accounts and the designated equity account have the types the ledger expects.
    let type_of = |c: &str| d.chart.get(&code(c)).unwrap().account_type;
    assert_eq!(type_of("140"), AccountType::Income);
    assert_eq!(type_of("965"), AccountType::Equity);
    assert_eq!(type_of("970"), AccountType::Equity);
    assert_eq!(type_of("810"), AccountType::Liability);

    // Every account maps to a line, P&L accounts on the P&L and the rest on the balance sheet.
    let pl = statement_lines(&d.template, "performance");
    let bs = statement_lines(&d.template, "position");
    for a in &d.accounts {
        let line = d
            .mapping
            .line_for(&a.code)
            .unwrap_or_else(|| panic!("{} isn't mapped", a.code));
        let lines = if a.account_type.is_balance_sheet() {
            &bs
        } else {
            &pl
        };
        assert!(
            lines.contains(line),
            "{} maps to {line}, on the wrong statement",
            a.code
        );
    }
    for (c, line) in CLIENT_ADDED {
        assert_eq!(d.mapping.line_for(&code(c)), Some(&key(line)), "{c}");
    }

    // Protected totals, as docs/domain.md specifies.
    let protect = |k: &str| match d.template.find(&key(k)).unwrap() {
        Node::Group { protect, .. } | Node::Total { protect, .. } => *protect,
        _ => None,
    };
    assert_eq!(protect("net_profit"), Some(1));
    assert_eq!(protect("assets"), Some(2));
    assert_eq!(protect("equity"), Some(3));
}

/// The default GST codes from the domain.md table: every income and expense account has one, and
/// no balance-sheet account does.
#[test]
fn default_gst_codes_follow_the_domain_table() {
    use acct_core::GstCode::{Exempt, None as Outside, Standard};
    let d = defaults();
    for a in &d.accounts {
        assert_eq!(
            a.default_gst.is_some(),
            !a.account_type.is_balance_sheet(),
            "{}",
            a.code
        );
    }
    let gst = |c: &str| d.chart.get(&code(c)).unwrap().default_gst;
    for c in ["110", "205", "220"] {
        assert_eq!(gst(c), Some(Exempt), "{c}");
    }
    for c in ["210", "240", "250", "295"] {
        assert_eq!(gst(c), Some(Outside), "{c}");
    }
    for c in ["100", "120", "140", "150", "202", "215", "225", "290"] {
        assert_eq!(gst(c), Some(Standard), "{c}");
    }
}

#[test]
fn rounding_priority_and_asset_classes_fit_the_chart() {
    let d = defaults();
    assert_eq!(
        d.priority,
        ["290", "205", "120", "960", "810"].map(code).to_vec()
    );
    for c in &d.priority {
        assert!(d.chart.get(c).is_some(), "{c} isn't in the chart");
    }

    let keys: Vec<&str> = d.classes.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys, ["tools", "vehicles", "computers", "furniture"]);
    for class in &d.classes {
        class.settings.method.validate().unwrap();
        assert!(
            matches!(class.settings.method, acct_core::Method::Dv { .. }),
            "{} isn't DV",
            class.key
        );
        let a = &class.accounts;
        // Each class has its own balance-sheet line, holding both its cost and its depreciation.
        let line = d.mapping.line_for(&a.cost).unwrap();
        assert_eq!(line, &key(&format!("fixed_{}", class.key)));
        assert_eq!(d.mapping.line_for(&a.accumulated), Some(line));
        for (c, t) in [
            (&a.cost, AccountType::Asset),
            (&a.accumulated, AccountType::Asset),
            (&a.expense, AccountType::Expense),
            (&a.gain_loss, AccountType::Expense),
        ] {
            assert_eq!(
                d.chart.get(c).map(|x| x.account_type),
                Some(t),
                "{}",
                class.key
            );
        }
    }
}

/// The default coding settings name accounts in the chart, of the right types, and each of the
/// accounts added for coding has its own line.
#[test]
fn coding_settings_fit_the_chart() {
    let d = defaults();
    let settings: acct_core::coding::CodingSettings =
        serde_json::from_str(CODING_SETTINGS).unwrap();
    settings.validate(&d.chart).unwrap();
    for (c, line) in [
        ("615", "gst_to_claim"),
        ("812", "gst_refunds"),
        ("952", "wages_paid_in"),
        ("954", "personal_sales"),
        ("962", "income_tax_paid"),
    ] {
        assert_eq!(d.mapping.line_for(&code(c)), Some(&key(line)), "{c}");
    }
}

/// A balanced TB touching every account builds a ReportDoc that foots, with drawings in brackets.
#[test]
fn builds_a_report() {
    let d = defaults();
    let mut tb = TrialBalance::default();
    let codes = d
        .accounts
        .iter()
        .map(|a| a.code.clone())
        .chain(CLIENT_ADDED.map(|(c, _)| code(c)))
        // Drawings are posted below as a debit, whatever the alternation would give them.
        .filter(|c| *c != code("970") && *c != code("960"));
    for (i, c) in codes.enumerate() {
        let i = i64::try_from(i).unwrap();
        // Odd cents so rounding has work to do; debits and credits alternate.
        let cents = (i + 1) * 12_345 + 49;
        tb.post(
            &c,
            Money::from_cents(if i % 2 == 0 { cents } else { -cents }),
        );
    }
    tb.post(&code("960"), Money::from_cents(500_000));
    tb.post(&code("970"), -tb.total());
    assert!(tb.is_balanced());

    let year = ClientYear::new(date("2025-04-01"), date("2026-03-31")).unwrap();
    let doc = build_report(&ReportInput {
        template: &d.template,
        mapping: &d.mapping,
        year: &year,
        tb: &tb,
        prior: None,
        rounding_priority: &d.priority,
    })
    .unwrap();

    let row = |k: &str| {
        doc.statements
            .iter()
            .flat_map(|s| &s.rows)
            .filter(|r| r.key == key(k))
            .filter_map(|r| r.current)
            .next_back()
            .unwrap_or_else(|| panic!("no amount for {k}"))
    };
    assert_eq!(row("net_assets"), row("equity"));
    assert_eq!(row("profit_for_year"), row("net_profit"));
    assert!(row("drawings") < 0, "drawings should show in brackets");
}

fn date(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

/// The pipeline accepts the defaults as a master user sets them up, and a sole-trader client
/// created from them.
#[tokio::test]
async fn pipeline_accepts_the_defaults() {
    let dir = TempDir::new().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    let actor = Actor {
        user_id: None,
        role: Role::PracticeAdmin,
    };
    let run = async |command: Command| -> String {
        let kind = command.kind();
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        let at = Utc.with_ymd_and_hms(2026, 10, 23, 0, 0, 0).unwrap();
        match submit(&store, &actor, envelope, at).await {
            Ok(a) => a.entity_id.unwrap(),
            Err(e) => panic!("{kind}: {:?}", e.body()),
        }
    };

    let d = defaults();
    run(Command::CreateMasterChart {
        entity_type: "sole_trader".into(),
        name: "Sole trader".into(),
        accounts: d.accounts,
    })
    .await;
    let template_id = run(Command::CreateTemplate {
        entity_type: "sole_trader".into(),
        name: "Sole trader (standard)".into(),
        body: d.template,
    })
    .await;
    run(Command::CreateMapping {
        template_id,
        name: "Sole trader (standard)".into(),
        body: d.mapping,
    })
    .await;
    for class in d.classes {
        run(Command::CreateAssetClass {
            entity_type: "sole_trader".into(),
            key: class.key,
            name: class.name,
            settings: class.settings,
            accounts: class.accounts,
        })
        .await;
    }
    let client_id = run(Command::CreateClient {
        name: "Example Sole Trader".into(),
        entity_type: "sole_trader".into(),
        retained_earnings: code("970"),
        rounding_priority: d.priority,
    })
    .await;

    // The client's chart is a copy of the master chart, default GST codes included.
    let mut r = store.reader().await.unwrap();
    let copied = acct_store::clients::chart(&mut r, &client_id)
        .await
        .unwrap();
    assert_eq!(copied, d.chart);
}
