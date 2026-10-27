//! M13's "every command kind has a plain-English description covered by a test".

use std::collections::{BTreeMap, BTreeSet};

use acct_core::Money;
use acct_store::log::LoggedCommand;
use chrono::{TimeZone, Utc};
use serde_json::{Value, json};

use super::{Changes, Fact, FieldChange, TaxChange, TaxFigure, describe, diff, dollars};
use crate::commands::Command;

const TEMPLATE: &str = include_str!("../../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../../fixtures/practice/sole-trader-mapping.json");
const CLASSES: &str = include_str!("../../../../fixtures/practice/sole-trader-asset-classes.json");
const SETTINGS: &str =
    include_str!("../../../../fixtures/practice/sole-trader-coding-settings.json");

/// Every command kind, from the `Command` enum's own list of variants (as `tests/tenancy.rs`
/// does it): serde names them all when it meets one it doesn't know.
fn all_kinds() -> BTreeSet<String> {
    let err = serde_json::from_value::<Command>(json!({ "kind": "?", "payload": {} }))
        .unwrap_err()
        .to_string();
    let list = err
        .split_once("expected one of ")
        .unwrap_or_else(|| panic!("serde's message changed: {err}"))
        .1;
    list.split(", ")
        .map(|k| {
            k.trim_matches(|c: char| c == '`' || c.is_whitespace())
                .to_owned()
        })
        .collect()
}

fn users() -> BTreeMap<String, String> {
    [("u-sam", "Sam"), ("u-ana", "Ana"), ("u-bo", "Bo")]
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect()
}

fn entry(kind: &str, payload: &Value, user: Option<&str>, via: Option<Value>) -> LoggedCommand {
    // Through the real command, so a payload that doesn't parse fails here, not as a fallback.
    let command: Command = serde_json::from_value(json!({ "kind": kind, "payload": payload }))
        .unwrap_or_else(|e| panic!("{kind}: {e}"));
    assert_eq!(command.kind(), kind);
    LoggedCommand {
        seq: 7,
        id: "00000000-0000-4000-8000-000000000000".into(),
        kind: kind.into(),
        payload: command.logged_payload().to_string(),
        result: "{}".into(),
        user_id: user.map(str::to_owned),
        client_id: Some("biz".into()),
        client_year_id: None,
        at: Utc.with_ymd_and_hms(2026, 10, 24, 1, 2, 3).unwrap(),
        via: via.map(|v| v.to_string()),
        changes: None,
    }
}

fn change(subject: &str, label: &str, before: Option<&str>, after: Option<&str>) -> FieldChange {
    FieldChange {
        subject: subject.into(),
        label: label.into(),
        before: before.map(str::to_owned),
        after: after.map(str::to_owned),
    }
}

fn changes(fields: Vec<FieldChange>) -> Changes {
    Changes { tax: None, fields }
}

fn with_tax(mut c: Changes, before: i64, after: i64) -> Changes {
    let figure = |cents| TaxFigure {
        total: Money::from_cents(cents),
        parts: BTreeMap::new(),
    };
    c.tax = Some(TaxChange {
        client_id: "biz".into(),
        before: Some(figure(before)),
        after: figure(after),
    });
    c
}

/// A sample of a command kind: its payload, what it changed, and the sentence it should give.
struct Sample {
    kind: &'static str,
    payload: Value,
    user: Option<&'static str>,
    via: Option<Value>,
    changes: Option<Changes>,
    expect: &'static str,
}

fn s(kind: &'static str, payload: Value, expect: &'static str) -> Sample {
    Sample {
        kind,
        payload,
        user: Some("u-sam"),
        via: None,
        changes: None,
        expect,
    }
}

impl Sample {
    fn changed(mut self, c: Changes) -> Sample {
        self.changes = Some(c);
        self
    }
    fn by(mut self, user: Option<&'static str>) -> Sample {
        self.user = user;
        self
    }
}

fn countdown(n: usize) -> Vec<FieldChange> {
    (1..=n)
        .map(|d| {
            change(
                &format!("COUNTDOWN AUCKLAND on {d} Mar 2026 (-$7)"),
                "category",
                Some("not sorted yet"),
                Some("personal"),
            )
        })
        .collect()
}

fn samples() -> Vec<Sample> {
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let classes: Vec<Value> = serde_json::from_str(CLASSES).unwrap();
    let class = &classes[0];
    let settings: Value = serde_json::from_str(SETTINGS).unwrap();
    let personal = json!({ "direction": "out", "kind": "personal" });
    let line = "COUNTDOWN AUCKLAND on 3 Mar 2026 (-$45.20)";
    vec![
        s(
            "initialise",
            json!({ "practice_name": "Example Practice", "username": "bo",
                    "display_name": "Bo", "password": "x" }),
            "The system set up the practice Example Practice, with Bo as its admin.",
        )
        .by(None),
        s(
            "create_user",
            json!({ "username": "val", "display_name": "Val", "password": "x", "role": "viewer" }),
            "Sam added Val as a viewer.",
        ),
        s(
            "change_own_password",
            json!({ "current_password": "a", "new_password": "b" }),
            "Sam changed their password.",
        ),
        s(
            "reset_password",
            json!({ "user_id": "u-ana", "new_password": "b" }),
            "Sam reset Ana's password.",
        ),
        s(
            "set_user_active",
            json!({ "user_id": "u-ana", "active": false }),
            "Sam made Ana inactive.",
        ),
        s(
            "create_master_chart",
            json!({ "entity_type": "sole_trader", "name": "Sole trader",
                    "accounts": [{ "code": "100", "name": "Sales",
                                   "account_type": "income", "active": true }] }),
            "Sam set up the sole trader master chart “Sole trader” with 1 account.",
        ),
        s(
            "install_starter_set",
            json!({ "set": "sole_trader" }),
            "Sam installed the sole trader starter set: a master chart, statement template, \
             mapping and asset classes.",
        ),
        s(
            "add_master_account",
            json!({ "entity_type": "sole_trader", "account": { "code": "299", "name": "Koha",
                    "account_type": "expense", "active": true } }),
            "Sam added account 299 Koha to the sole trader master chart.",
        ),
        s(
            "rename_master_account",
            json!({ "entity_type": "company", "code": "200", "name": "Advertising" }),
            "Sam renamed account 200 in the company master chart from “Ads” to “Advertising”.",
        )
        .changed(changes(vec![change(
            "company master chart account 200",
            "name",
            Some("Ads"),
            Some("Advertising"),
        )])),
        s(
            "set_master_account_active",
            json!({ "entity_type": "company", "code": "200", "active": false }),
            "Sam made account 200 in the company master chart inactive.",
        ),
        s(
            "set_master_account_gst",
            json!({ "entity_type": "sole_trader", "code": "110", "default_gst": null }),
            "Sam cleared account 110's default GST in the sole trader master chart.",
        ),
        s(
            "create_template",
            json!({ "entity_type": "sole_trader", "name": "Standard", "body": template }),
            "Sam created the statement template “Standard”.",
        ),
        s(
            "revise_template",
            json!({ "template_id": "t1", "body": template }),
            "Sam revised a statement template.",
        ),
        s(
            "move_year_layout",
            json!({ "client_year_id": "y1" }),
            "Sam moved the year ending 31 Mar 2026 onto Sole trader (standard) v2, mapping \
             Sole trader (standard) v1.",
        )
        .changed(changes(vec![change(
            "the year ending 31 Mar 2026",
            "layout",
            Some("Sole trader (standard) v1, mapping Sole trader (standard) v1"),
            Some("Sole trader (standard) v2, mapping Sole trader (standard) v1"),
        )])),
        s(
            "create_mapping",
            json!({ "template_id": "t1", "name": "Standard", "body": mapping }),
            "Sam created the mapping “Standard”.",
        ),
        s(
            "revise_mapping",
            json!({ "mapping_id": "m1", "body": mapping }),
            "Sam revised a mapping.",
        ),
        s(
            "create_client",
            json!({ "name": "Kōwhai Gardens", "entity_type": "sole_trader",
                    "retained_earnings": "970", "rounding_priority": [] }),
            "Sam added the client Kōwhai Gardens (sole trader).",
        ),
        s(
            "add_account",
            json!({ "client_id": "biz", "account": { "code": "299", "name": "Koha",
                    "account_type": "expense", "active": true } }),
            "Sam added account 299 Koha.",
        ),
        s(
            "rename_account",
            json!({ "client_id": "biz", "code": "200", "name": "Advertising" }),
            "Sam renamed account 200 from “Ads” to “Advertising”.",
        )
        .changed(changes(vec![change(
            "account 200",
            "name",
            Some("Ads"),
            Some("Advertising"),
        )])),
        s(
            "set_account_active",
            json!({ "client_id": "biz", "code": "200", "active": false }),
            "Sam made account 200 inactive.",
        ),
        s(
            "set_account_gst",
            json!({ "client_id": "biz", "code": "110", "default_gst": "exempt" }),
            "Sam set account 110's default GST to exempt.",
        ),
        s(
            "set_rounding_priority",
            json!({ "client_id": "biz", "rounding_priority": ["290", "100"] }),
            "Sam set the rounding order to 290, 100.",
        ),
        s(
            "create_client_year",
            json!({ "client_id": "biz", "start": "2026-04-01", "end": "2027-03-31" }),
            "Sam added the year 1 Apr 2026 to 31 Mar 2027.",
        ),
        s(
            "post_journal",
            json!({ "client_year_id": "y1", "date": "2026-08-01", "narration": "Accrue fees",
                    "lines": [{ "account": "290", "amount": 50000 },
                              { "account": "800", "amount": -50000 }] }),
            "Sam posted a journal on 1 Aug 2026 for $500: “Accrue fees”. Tax to pay went down $150.",
        )
        .changed(with_tax(changes(vec![]), 30000, 15000)),
        s(
            "import_tb",
            json!({ "client_year_id": "y1",
                    "rows": [{ "account": "100", "balance": -100 },
                             { "account": "600", "balance": 100 }] }),
            "Sam imported a trial balance of 2 accounts.",
        ),
        s(
            "reverse_journal",
            json!({ "journal_id": "j1" }),
            "Sam reversed a journal.",
        ),
        s(
            "create_asset_class",
            json!({ "entity_type": "sole_trader", "key": "x", "name": "Vehicles",
                    "settings": class["settings"], "accounts": class["accounts"] }),
            "Sam added the asset class “Vehicles”.",
        ),
        s(
            "update_asset_class",
            json!({ "class_id": "c1", "name": "Vehicles",
                    "settings": class["settings"], "accounts": class["accounts"] }),
            "Sam changed the asset class “Vehicles”.",
        ),
        s(
            "set_client_asset_class",
            json!({ "client_id": "biz", "class_id": "c1" }),
            "Sam went back to the practice's settings for an asset class.",
        ),
        s(
            "create_asset",
            json!({ "client_id": "biz", "class_id": "c1", "name": "Ute", "cost": 2500000,
                    "residual": 0, "acquired": "2026-05-01" }),
            "Sam added the asset “Ute”, costing $25,000.",
        ),
        s(
            "update_asset",
            json!({ "asset_id": "a1", "name": "Ute", "cost": 2500000, "residual": 0,
                    "acquired": "2026-05-01" }),
            "Sam changed the asset “Ute”.",
        ),
        s(
            "delete_asset",
            json!({ "asset_id": "a1" }),
            "Sam removed the asset Ute.",
        )
        .changed(changes(vec![change("asset Ute", "name", Some("Ute"), None)])),
        s(
            "dispose_asset",
            json!({ "asset_id": "a1",
                    "disposal": { "date": "2026-09-01", "proceeds": 1000000,
                                  "proceeds_account": "600" } }),
            "Sam recorded the disposal of the asset Ute on 1 Sep 2026, for $10,000.",
        )
        .changed(changes(vec![change(
            "asset Ute",
            "disposal",
            Some("not disposed of"),
            Some("on 1 Sep 2026 for $10,000"),
        )])),
        s(
            "reinstate_asset",
            json!({ "asset_id": "a1" }),
            "Sam undid the disposal of the asset.",
        ),
        s(
            "run_depreciation",
            json!({ "client_year_id": "y1" }),
            "Sam ran depreciation. Tax to pay went down $42.50.",
        )
        .changed(with_tax(changes(vec![]), 10000, 5750)),
        s(
            "apply_asset_class_defaults",
            json!({ "client_id": "biz", "class_id": "c1" }),
            "Sam applied an asset class's defaults to this client's assets.",
        ),
        s(
            "set_up_business",
            json!({ "name": "Kōwhai Gardens", "start_date": "2025-04-01" }),
            "Sam set up the business Kōwhai Gardens.",
        ),
        s(
            "add_bank_account",
            json!({ "client_id": "biz", "name": "Business cheque" }),
            "Sam added the bank account “Business cheque”.",
        ),
        s(
            "import_statement",
            json!({ "client_id": "biz", "file_name": "aug.csv", "content_base64": "" }),
            "Ana uploaded the statement aug.csv, adding 25 new transactions. Tax to pay went up $1,200.",
        )
        .by(Some("u-ana"))
        .changed(with_tax(
            changes(vec![change(
                "bank statements",
                "transactions",
                Some("10"),
                Some("35"),
            )]),
            0,
            120000,
        )),
        s(
            "set_opening_balance",
            json!({ "bank_account_id": "b1", "balance": 123456 }),
            "Sam set a bank account's opening balance to $1,234.56.",
        ),
        s(
            "code_bank_line",
            json!({ "bank_line_id": "l1",
                    "coding": { "direction": "out", "kind": "expense",
                                "account": "200", "gst": "standard" } }),
            "Ana marked COUNTDOWN AUCKLAND on 3 Mar 2026 (-$45.20) as Advertising. \
             Tax to pay went down $13.56.",
        )
        .by(Some("u-ana"))
        .changed(with_tax(
            changes(vec![change(
                line,
                "category",
                Some("not sorted yet"),
                Some("Advertising"),
            )]),
            50000,
            48644,
        )),
        // PLAN.md's own example.
        s(
            "code_bank_lines",
            json!({ "lines": (1..=12).map(|i| json!({ "bank_line_id": format!("l{i}"),
                                                       "coding": personal }))
                                     .collect::<Vec<_>>() }),
            "Sam marked 12 COUNTDOWN transactions as personal. Tax to pay went up $84.",
        )
        .changed(with_tax(changes(countdown(12)), 10000, 18400)),
        s(
            "add_rule",
            json!({ "client_id": "biz", "description_contains": "COUNTDOWN", "coding": personal }),
            "Ana added a rule: always treat “COUNTDOWN” as personal, which sorted 3 transactions.",
        )
        .by(Some("u-ana"))
        .changed(changes({
            let mut f = vec![change(
                "rule for “COUNTDOWN”",
                "rule",
                None,
                Some("always treat “COUNTDOWN” as personal"),
            )];
            f.extend(countdown(3));
            f
        })),
        s(
            "remove_rule",
            json!({ "rule_id": "r1" }),
            "Ana removed the rule always treat “COUNTDOWN” as personal.",
        )
        .by(Some("u-ana"))
        .changed(changes(vec![change(
            "rule for “COUNTDOWN”",
            "rule",
            Some("always treat “COUNTDOWN” as personal"),
            None,
        )])),
        s(
            "answer_question",
            json!({ "client_id": "biz", "income_year": 2027,
                    "answer": { "question": "only_income", "yes": true } }),
            "Ana said this business is their only income, for the year to 31 March 2027. \
             Tax to pay went down $1,538.",
        )
        .by(Some("u-ana"))
        .changed(with_tax(changes(vec![]), 250632, 96832)),
        s(
            "confirm_transfer",
            json!({ "out_line_id": "l1", "in_line_id": "l2" }),
            "Sam confirmed a transfer between the business's own accounts.",
        ),
        s(
            "confirm_ird_payment",
            json!({ "bank_line_id": "l1", "payment": { "kind": "income_tax", "income_year": 2026 } }),
            "Sam confirmed IRD on 3 Mar 2026 (-$500) was income tax for the year to 31 March 2026.",
        )
        .changed(changes(vec![change(
            "IRD on 3 Mar 2026 (-$500)",
            "category",
            Some("not sorted yet"),
            Some("income tax paid to IRD"),
        )])),
        s(
            "resolve_duplicate",
            json!({ "bank_line_id": "l1", "is_duplicate": true }),
            "Sam marked a transaction as a duplicate.",
        ),
        s(
            "confirm_supply_info",
            json!({ "bank_line_id": "l1" }),
            "Sam confirmed they hold the supplier's GST information for a transaction.",
        ),
        s(
            "add_card_account",
            json!({ "client_id": "biz", "name": "Visa" }),
            "Sam added the credit card “Visa”.",
        ),
        s(
            "set_coding_settings",
            json!({ "client_id": "biz", "settings": settings }),
            "Sam changed the coding settings.",
        ),
        s(
            "set_ai_suggestions",
            json!({ "client_id": "biz", "enabled": true, "consent_version": "1" }),
            "Ana turned AI suggestions on.",
        )
        .by(Some("u-ana")),
        s(
            "add_merchant",
            json!({ "entity_type": "sole_trader", "description_contains": "Z ENERGY",
                    "coding": { "direction": "out", "kind": "expense",
                                "account": "250", "gst": "standard" } }),
            "Bo added “Z ENERGY” to the sole trader merchant list as account 250.",
        )
        .by(Some("u-bo")),
        s(
            "remove_merchant",
            json!({ "merchant_id": "m1" }),
            "Bo took an entry off the merchant list.",
        )
        .by(Some("u-bo")),
        s(
            "record_suggestions",
            json!({ "client_id": "biz", "model": "claude-haiku-5-5",
                    "suggestions": [{ "bank_line_id": "l1", "coding": personal,
                                      "confidence": "high" }] }),
            "Ana asked AI (claude-haiku-5-5) for suggestions, and got 1 suggestion.",
        )
        .by(Some("u-ana")),
        s(
            "sign_up",
            json!({ "email": "ana@example.nz", "display_name": "Ana", "password": "x",
                    "business_name": "Ana's Gardens", "start_date": "2025-04-01" }),
            "Ana signed up with the business Ana's Gardens.",
        )
        .by(None),
        s(
            "create_invite",
            json!({ "client_id": "biz", "email": "sam@example.nz", "token": "ab" }),
            "Ana invited sam@example.nz to be the business's accountant.",
        )
        .by(Some("u-ana")),
        s(
            "accept_invite",
            json!({ "token": "ab" }),
            "Sam accepted an invite to work on this business.",
        ),
        s(
            "finalise_year",
            json!({ "client_year_id": "y1", "accept_uncategorised": true }),
            "Bo finalised the year ending 31 Mar 2026, accepting any unsorted bank lines as they are.",
        )
        .by(Some("u-bo"))
        .changed(changes(vec![change(
            "the year ending 31 Mar 2026",
            "status",
            Some("open"),
            Some("finalised"),
        )])),
        s(
            "reopen_year",
            json!({ "client_year_id": "y1", "reason": "Client found a missing invoice" }),
            "Bo reopened a year, because “Client found a missing invoice”.",
        )
        .by(Some("u-bo")),
        s(
            "add_paragraph",
            json!({ "entity_type": "sole_trader",
                    "paragraph": { "key": "going_concern", "placement": "policy",
                                   "title": "Going concern", "body": "For {business_name}." } }),
            "Bo added “Going concern” to the sole trader paragraph library.",
        )
        .by(Some("u-bo")),
        s(
            "revise_paragraph",
            json!({ "paragraph_id": "p1", "placement": "policy", "title": "Going concern",
                    "body": "Revised." }),
            "Bo revised the library paragraph “Going concern”.",
        )
        .by(Some("u-bo")),
        s(
            "pick_notes",
            json!({ "client_year_id": "y1", "paragraph_ids": ["p1", "p2"] }),
            "Sam chose this year's notes (2 paragraphs).",
        ),
        s(
            "edit_note",
            json!({ "client_year_id": "y1", "paragraph_id": "p1", "title": "Going concern",
                    "body": "Edited." }),
            "Sam edited this year's note “Going concern”.",
        ),
        s(
            "push_paragraph",
            json!({ "paragraph_id": "p1" }),
            "Bo pushed a library paragraph's latest wording onto open years.",
        )
        .by(Some("u-bo")),
        s(
            "remove_paragraph",
            json!({ "paragraph_id": "p1" }),
            "Bo removed a paragraph from the library.",
        )
        .by(Some("u-bo")),
        s(
            "set_history_sharing",
            json!({ "client_id": "biz", "share_owner_edits": true }),
            "Sam let their accountants see the owner's edits in Changes.",
        ),
        s(
            "save_invoice_draft",
            json!({ "html": "<p>Invoice</p>" }),
            "Sam saved their invoice.",
        ),
        s(
            "save_invoice_template",
            json!({ "name": "Plain", "html": "<p>Invoice</p>" }),
            "Sam saved an invoice template.",
        ),
        s(
            "delete_invoice_template",
            json!({ "template_id": "t1" }),
            "Sam deleted an invoice template.",
        ),
        s(
            "add_invoice_image",
            json!({ "content_base64": "iVBORw0KGgo=" }),
            "Sam added an image to their invoices.",
        ),
    ]
}

#[test]
fn every_command_kind_has_a_sample() {
    let sampled: BTreeSet<String> = samples().iter().map(|s| s.kind.to_owned()).collect();
    let missing: Vec<_> = all_kinds().difference(&sampled).cloned().collect();
    assert!(
        missing.is_empty(),
        "no description sample in history/tests.rs for: {missing:?}"
    );
}

#[test]
fn every_command_kind_reads_as_plain_english() {
    for sample in samples() {
        let e = entry(
            sample.kind,
            &sample.payload,
            sample.user,
            sample.via.clone(),
        );
        let got = describe(&e, sample.changes.as_ref(), &users());
        assert_eq!(got, sample.expect, "{}", sample.kind);
    }
}

#[test]
fn accepted_ai_suggestions_say_so() {
    let personal = json!({ "direction": "out", "kind": "personal" });
    let e = entry(
        "code_bank_lines",
        &json!({ "lines": [{ "bank_line_id": "l1", "coding": personal },
                           { "bank_line_id": "l2", "coding": personal }] }),
        Some("u-ana"),
        Some(json!({ "kind": "suggestion", "model": "claude-haiku-5-5",
                     "suggestion_ids": ["s1", "s2"] })),
    );
    let got = describe(&e, Some(&changes(countdown(2))), &users());
    assert_eq!(
        got,
        "Ana accepted 2 AI suggestions: marked 2 COUNTDOWN transactions as personal."
    );
}

#[test]
fn mixed_recodes_and_no_ops_read_sensibly() {
    let personal = json!({ "direction": "out", "kind": "personal" });
    let payload = json!({ "lines": [{ "bank_line_id": "l1", "coding": personal },
                                    { "bank_line_id": "l2", "coding": personal }] });
    let e = entry("code_bank_lines", &payload, Some("u-sam"), None);
    let mixed = changes(vec![
        change(
            "COUNTDOWN on 1 Mar 2026 (-$7)",
            "category",
            None,
            Some("personal"),
        ),
        change(
            "Z ENERGY on 1 Mar 2026 (-$70)",
            "category",
            None,
            Some("Vehicle"),
        ),
    ]);
    assert_eq!(
        describe(&e, Some(&mixed), &users()),
        "Sam sorted 2 transactions."
    );
    assert_eq!(
        describe(&e, Some(&changes(vec![])), &users()),
        "Sam sorted 2 transactions, with no change."
    );
}

#[test]
fn an_entry_that_no_longer_parses_still_reads() {
    let mut e = entry(
        "reverse_journal",
        &json!({ "journal_id": "j1" }),
        Some("u-gone"),
        None,
    );
    e.kind = "retired_kind".into();
    assert_eq!(
        describe(&e, None, &users()),
        "Someone made a change (retired kind)."
    );
}

#[test]
fn diff_keeps_only_what_changed() {
    let f = |key: &str, value: &str| Fact {
        key: key.into(),
        subject: key.into(),
        label: "category".into(),
        value: value.into(),
    };
    let before = [f("a", "1"), f("b", "2"), f("c", "3")];
    let after = [f("a", "1"), f("b", "9"), f("d", "4")];
    assert_eq!(
        diff(&before, &after),
        vec![
            change("b", "category", Some("2"), Some("9")),
            change("c", "category", Some("3"), None),
            change("d", "category", None, Some("4")),
        ]
    );
}

#[test]
fn dollars_read_like_money() {
    let d = |c| dollars(Money::from_cents(c));
    assert_eq!(d(8400), "$84");
    assert_eq!(d(-4520), "-$45.20");
    assert_eq!(d(123_456_789), "$1,234,567.89");
    assert_eq!(d(0), "$0");
}
