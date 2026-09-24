//! The command pipeline against a real database: the fixture company built entirely from
//! commands, and every rejection leaving no trace.

use acct_core::{
    Account, AccountCode, Journal, JournalLine, Mapping, Money, Template, TrialBalance,
};
use acct_server::commands::{Accepted, Command, CommandEnvelope};
use acct_server::error::CommandError;
use acct_server::pipeline::{Actor, submit};
use acct_store::users::Role;
use acct_store::{Store, clients, journals, years};
use chrono::{NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/company-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/company-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/company-mapping.json");
const CLIENT: &str = include_str!("../../../fixtures/clients/example-widgets.json");

#[derive(Deserialize)]
struct FixtureClient {
    name: String,
    entity_type: String,
    retained_earnings: AccountCode,
    rounding_priority: Vec<AccountCode>,
    years: Vec<FixtureYear>,
}

#[derive(Deserialize)]
struct FixtureYear {
    start: NaiveDate,
    end: NaiveDate,
    journals: Vec<Journal>,
}

fn fixture() -> FixtureClient {
    serde_json::from_str(CLIENT).unwrap()
}

fn master() -> Actor {
    Actor {
        user_id: None,
        role: Role::Master,
    }
}

fn as_role(role: Role) -> Actor {
    Actor {
        user_id: None,
        role,
    }
}

fn code(s: &str) -> AccountCode {
    s.parse().unwrap()
}

fn date(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn envelope(command: Command) -> CommandEnvelope {
    CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command,
    }
}

struct Harness {
    _dir: TempDir,
    store: Store,
}

impl Harness {
    async fn new() -> Harness {
        let dir = TempDir::new().unwrap();
        let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
        Harness { _dir: dir, store }
    }

    async fn run_as(&self, actor: &Actor, command: Command) -> Result<Accepted, CommandError> {
        let at = Utc.with_ymd_and_hms(2026, 9, 23, 0, 0, 0).unwrap();
        submit(&self.store, actor, envelope(command), at).await
    }

    async fn run(&self, command: Command) -> Result<Accepted, CommandError> {
        self.run_as(&master(), command).await
    }

    async fn ok(&self, command: Command) -> String {
        let kind = command.kind();
        match self.run(command).await {
            Ok(a) => a.entity_id.unwrap(),
            Err(e) => panic!("{kind}: {:?}", e.body()),
        }
    }

    /// Runs a command that creates nothing, and panics if it's rejected.
    async fn ok_none(&self, command: Command) {
        let kind = command.kind();
        if let Err(e) = self.run(command).await {
            panic!("{kind}: {:?}", e.body());
        }
    }

    /// Row counts in every table a command can write, to show a rejection left nothing.
    async fn counts(&self) -> Vec<i64> {
        let mut r = self.store.reader().await.unwrap();
        let mut out = Vec::new();
        for sql in [
            "SELECT COUNT(*) FROM command_log",
            "SELECT COUNT(*) FROM master_charts",
            "SELECT COUNT(*) FROM templates",
            "SELECT COUNT(*) FROM template_versions",
            "SELECT COUNT(*) FROM mappings",
            "SELECT COUNT(*) FROM mapping_versions",
            "SELECT COUNT(*) FROM clients",
            "SELECT COUNT(*) FROM accounts",
            "SELECT COUNT(*) FROM client_years",
            "SELECT COUNT(*) FROM journals",
            "SELECT COUNT(*) FROM journal_lines",
        ] {
            let (n,): (i64,) = acct_store::sqlx::query_as(sql)
                .fetch_one(&mut *r)
                .await
                .unwrap();
            out.push(n);
        }
        out
    }

    /// Asserts the command is rejected with `code` and changes nothing.
    async fn rejects(&self, actor: &Actor, command: Command, code: &str) -> CommandError {
        let before = self.counts().await;
        let err = self.run_as(actor, command).await.unwrap_err();
        assert_eq!(err.body().code, code, "{:?}", err.body());
        assert_eq!(
            self.counts().await,
            before,
            "a rejected command left rows behind"
        );
        err
    }
}

/// Practice defaults for companies, as a master user sets them up. Returns (template, mapping).
async fn practice_defaults(h: &Harness) -> (String, String) {
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    h.ok(Command::CreateMasterChart {
        entity_type: "company".into(),
        name: "Company".into(),
        accounts,
    })
    .await;
    let template_id = h
        .ok(Command::CreateTemplate {
            entity_type: "company".into(),
            name: "Company (standard)".into(),
            body: serde_json::from_str(TEMPLATE).unwrap(),
        })
        .await;
    let mapping_id = h
        .ok(Command::CreateMapping {
            template_id: template_id.clone(),
            name: "Company (standard)".into(),
            body: serde_json::from_str(MAPPING).unwrap(),
        })
        .await;
    (template_id, mapping_id)
}

async fn create_client(h: &Harness) -> String {
    let f = fixture();
    h.ok(Command::CreateClient {
        name: f.name,
        entity_type: f.entity_type,
        retained_earnings: f.retained_earnings,
        rounding_priority: f.rounding_priority,
    })
    .await
}

async fn create_year(h: &Harness, client_id: &str, start: &str, end: &str) -> String {
    h.ok(Command::CreateClientYear {
        client_id: client_id.into(),
        start: date(start),
        end: date(end),
        mapping_id: None,
    })
    .await
}

fn post(year_id: &str, j: &Journal) -> Command {
    Command::PostJournal {
        client_year_id: year_id.into(),
        date: j.date,
        narration: j.narration.clone(),
        lines: j.lines.clone(),
    }
}

fn line(account: &str, cents: i64) -> JournalLine {
    JournalLine {
        account: code(account),
        amount: Money::from_cents(cents),
    }
}

fn journal_on(year_id: &str, d: &str, lines: Vec<JournalLine>) -> Command {
    Command::PostJournal {
        client_year_id: year_id.into(),
        date: date(d),
        narration: "Test".into(),
        lines,
    }
}

/// The fixture company with its first year, ready for journals. Returns (client, year).
async fn company_with_year(h: &Harness) -> (String, String) {
    practice_defaults(h).await;
    let client_id = create_client(h).await;
    let year_id = create_year(h, &client_id, "2024-04-01", "2025-03-31").await;
    (client_id, year_id)
}

#[tokio::test]
async fn the_fixture_company_builds_from_commands() {
    let h = Harness::new().await;
    practice_defaults(&h).await;
    let client_id = create_client(&h).await;
    let f = fixture();
    let mut year_ids = Vec::new();
    for y in &f.years {
        let year_id = create_year(&h, &client_id, &y.start.to_string(), &y.end.to_string()).await;
        for j in &y.journals {
            h.ok(post(&year_id, j)).await;
        }
        year_ids.push(year_id);
    }

    let mut r = h.store.reader().await.unwrap();
    // The client's chart is a copy of the master chart.
    let chart = clients::chart(&mut r, &client_id).await.unwrap();
    let master: Vec<Account> = serde_json::from_str(CHART).unwrap();
    assert_eq!(chart.accounts(), master.as_slice());
    // Both years pin the same versions, and the stored journals are the fixture's.
    let y0 = years::get(&mut r, &year_ids[0]).await.unwrap().unwrap();
    let y1 = years::get(&mut r, &year_ids[1]).await.unwrap().unwrap();
    assert_eq!(
        (&y0.template_version_id, &y0.mapping_version_id),
        (&y1.template_version_id, &y1.mapping_version_id)
    );
    for (i, y) in f.years.iter().enumerate() {
        let stored = journals::for_year(&mut r, &year_ids[i]).await.unwrap();
        let stored: Vec<Journal> = stored.into_iter().map(|j| j.journal).collect();
        assert_eq!(stored, y.journals);
        let tb = TrialBalance::from_journals(&TrialBalance::default(), &stored);
        assert!(tb.is_balanced());
    }
    // Every accepted command is logged in order, with no gaps.
    let log = acct_store::log::after(&mut r, 0, 1000).await.unwrap();
    let seqs: Vec<i64> = log.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, (1..=log.len() as i64).collect::<Vec<_>>());
    assert!(
        log.iter()
            .all(|e| e.at == Utc.with_ymd_and_hms(2026, 9, 23, 0, 0, 0).unwrap())
    );
    let last = log.last().unwrap();
    assert_eq!(last.kind, "post_journal");
    assert_eq!(last.client_id.as_deref(), Some(client_id.as_str()));
    assert_eq!(last.client_year_id.as_deref(), Some(year_ids[1].as_str()));
}

#[tokio::test]
async fn resubmitting_an_id_returns_the_original_result() {
    let h = Harness::new().await;
    let (_, year_id) = company_with_year(&h).await;
    let e = envelope(journal_on(
        &year_id,
        "2024-05-01",
        vec![line("600", 100), line("100", -100)],
    ));
    let at = Utc::now();
    let first = submit(&h.store, &master(), e.clone(), at).await.unwrap();
    let before = h.counts().await;
    let again = submit(&h.store, &master(), e.clone(), at).await.unwrap();
    assert_eq!(first, again);
    assert_eq!(h.counts().await, before);

    // The same id in another spelling is the same key.
    let upper = CommandEnvelope {
        id: e.id.to_uppercase(),
        ..e.clone()
    };
    assert_eq!(submit(&h.store, &master(), upper, at).await.unwrap(), first);

    // Reusing the id for something else is refused.
    let other = CommandEnvelope {
        id: e.id.clone(),
        command: journal_on(
            &year_id,
            "2024-05-02",
            vec![line("600", 5), line("100", -5)],
        ),
    };
    let err = submit(&h.store, &master(), other, at).await.unwrap_err();
    assert_eq!(err.body().code, "id_reused");
    assert_eq!(h.counts().await, before);
}

#[tokio::test]
async fn an_id_must_be_a_uuid() {
    let h = Harness::new().await;
    let e = CommandEnvelope {
        id: "not-a-uuid".into(),
        command: Command::CreateMasterChart {
            entity_type: "company".into(),
            name: "x".into(),
            accounts: vec![],
        },
    };
    let err = submit(&h.store, &master(), e, Utc::now())
        .await
        .unwrap_err();
    assert_eq!(err.body().code, "malformed");
    assert_eq!(h.counts().await.iter().sum::<i64>(), 0);
}

#[tokio::test]
async fn roles_are_enforced() {
    let h = Harness::new().await;
    let (_, year_id) = company_with_year(&h).await;
    let j = journal_on(
        &year_id,
        "2024-05-01",
        vec![line("600", 100), line("100", -100)],
    );
    h.rejects(&as_role(Role::Viewer), j.clone(), "forbidden")
        .await;
    h.run_as(&as_role(Role::Staff), j).await.unwrap();
    // Practice defaults are for the master user only.
    let template = Command::CreateTemplate {
        entity_type: "trust".into(),
        name: "Trust".into(),
        body: serde_json::from_str(TEMPLATE).unwrap(),
    };
    h.rejects(&as_role(Role::Staff), template, "forbidden")
        .await;
}

#[tokio::test]
async fn journals_that_break_the_invariants_are_rejected() {
    let h = Harness::new().await;
    let (_, year_id) = company_with_year(&h).await;
    let m = master();
    let cases = [
        (vec![line("600", 100)], "2024-05-01", "too_few_lines"),
        (
            vec![line("600", 100), line("100", -99)],
            "2024-05-01",
            "unbalanced",
        ),
        (
            vec![line("600", 100), line("123", -100)],
            "2024-05-01",
            "unknown_account",
        ),
        (
            vec![line("600", 100), line("100", -100)],
            "2025-04-01",
            "outside_year",
        ),
    ];
    for (lines, d, problem) in cases {
        let err = h
            .rejects(&m, journal_on(&year_id, d, lines), "invalid_journal")
            .await;
        let details = err.body().details;
        assert_eq!(details[0]["code"], problem, "{details}");
    }
    h.rejects(
        &m,
        journal_on(
            "no-such-year",
            "2024-05-01",
            vec![line("600", 1), line("100", -1)],
        ),
        "not_found",
    )
    .await;
}

#[tokio::test]
async fn journals_to_inactive_accounts_are_rejected() {
    let h = Harness::new().await;
    let mut accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    accounts
        .iter_mut()
        .find(|a| a.code == code("290"))
        .unwrap()
        .active = false;
    h.ok(Command::CreateMasterChart {
        entity_type: "trust".into(),
        name: "Trust".into(),
        accounts,
    })
    .await;
    let template_id = h
        .ok(Command::CreateTemplate {
            entity_type: "trust".into(),
            name: "Trust".into(),
            body: serde_json::from_str(TEMPLATE).unwrap(),
        })
        .await;
    h.ok(Command::CreateMapping {
        template_id,
        name: "Trust".into(),
        body: serde_json::from_str(MAPPING).unwrap(),
    })
    .await;
    let client_id = h
        .ok(Command::CreateClient {
            name: "Example Family Trust".into(),
            entity_type: "trust".into(),
            retained_earnings: code("960"),
            rounding_priority: vec![],
        })
        .await;
    let year_id = create_year(&h, &client_id, "2024-04-01", "2025-03-31").await;
    let err = h
        .rejects(
            &master(),
            journal_on(
                &year_id,
                "2024-05-01",
                vec![line("290", 100), line("600", -100)],
            ),
            "invalid_journal",
        )
        .await;
    assert_eq!(err.body().details[0]["code"], "inactive_account");
}

#[tokio::test]
async fn finalised_years_reject_journals() {
    let h = Harness::new().await;
    let (_, year_id) = company_with_year(&h).await;
    let e = h
        .run(journal_on(
            &year_id,
            "2024-05-01",
            vec![line("600", 100), line("100", -100)],
        ))
        .await
        .unwrap();
    // There's no finalise command until M5, so this test sets the status directly.
    {
        let mut w = h.store.writer().await;
        acct_store::sqlx::query("UPDATE client_years SET status = 'finalised' WHERE id = ?")
            .bind(&year_id)
            .execute(&mut *w)
            .await
            .unwrap();
    }
    h.rejects(
        &master(),
        journal_on(
            &year_id,
            "2024-05-01",
            vec![line("600", 1), line("100", -1)],
        ),
        "year_finalised",
    )
    .await;
    h.rejects(
        &master(),
        Command::ReverseJournal {
            journal_id: e.entity_id.unwrap(),
            date: None,
            narration: None,
        },
        "year_finalised",
    )
    .await;
}

#[tokio::test]
async fn a_journal_reverses_once() {
    let h = Harness::new().await;
    let (_, year_id) = company_with_year(&h).await;
    let original = h
        .ok(journal_on(
            &year_id,
            "2024-05-01",
            vec![line("600", 250), line("100", -250)],
        ))
        .await;
    let reverse = |d: Option<&str>| Command::ReverseJournal {
        journal_id: original.clone(),
        date: d.map(date),
        narration: None,
    };
    h.rejects(&master(), reverse(Some("2025-06-30")), "invalid_journal")
        .await;
    let reversal = h.ok(reverse(Some("2024-06-30"))).await;
    h.rejects(&master(), reverse(None), "already_reversed")
        .await;

    let mut r = h.store.reader().await.unwrap();
    let stored = journals::get(&mut r, &reversal).await.unwrap().unwrap();
    assert_eq!(
        stored.reverses_journal_id.as_deref(),
        Some(original.as_str())
    );
    assert_eq!(stored.journal.date, date("2024-06-30"));
    assert_eq!(stored.journal.narration, "Reversal of: Test");
    assert_eq!(
        stored.journal.lines,
        vec![line("600", -250), line("100", 250)]
    );
    let all: Vec<Journal> = journals::for_year(&mut r, &year_id)
        .await
        .unwrap()
        .into_iter()
        .map(|j| j.journal)
        .collect();
    assert!(
        TrialBalance::from_journals(&TrialBalance::default(), &all)
            .iter()
            .all(|(_, b)| b.is_zero())
    );
}

#[tokio::test]
async fn clients_need_a_valid_master_chart_and_accounts() {
    let h = Harness::new().await;
    let client = |re: &str, priority: Vec<&str>| Command::CreateClient {
        name: "Example Widgets Limited".into(),
        entity_type: "company".into(),
        retained_earnings: code(re),
        rounding_priority: priority.into_iter().map(code).collect(),
    };
    h.rejects(&master(), client("960", vec![]), "no_master_chart")
        .await;
    practice_defaults(&h).await;
    // 600 is an asset, and 123 isn't in the chart.
    h.rejects(
        &master(),
        client("600", vec![]),
        "invalid_retained_earnings",
    )
    .await;
    h.rejects(
        &master(),
        client("123", vec![]),
        "invalid_retained_earnings",
    )
    .await;
    let err = h
        .rejects(
            &master(),
            client("960", vec!["235", "123", "235"]),
            "invalid_rounding_priority",
        )
        .await;
    assert_eq!(err.body().details.as_array().unwrap().len(), 2);
    h.rejects(
        &master(),
        Command::CreateClient {
            name: "  ".into(),
            entity_type: "company".into(),
            retained_earnings: code("960"),
            rounding_priority: vec![],
        },
        "empty_name",
    )
    .await;
    h.ok(client("960", vec!["235"])).await;
}

#[tokio::test]
async fn years_must_be_adjacent() {
    let h = Harness::new().await;
    let (client_id, _) = company_with_year(&h).await;
    let year = |start: &str, end: &str| Command::CreateClientYear {
        client_id: client_id.clone(),
        start: date(start),
        end: date(end),
        mapping_id: None,
    };
    h.rejects(
        &master(),
        year("2025-04-02", "2026-03-31"),
        "year_not_adjacent",
    )
    .await;
    h.rejects(
        &master(),
        year("2024-04-01", "2025-03-31"),
        "year_not_adjacent",
    )
    .await;
    h.rejects(&master(), year("2026-03-31", "2025-04-01"), "invalid_dates")
        .await;
    // Before the first year, or after the last.
    h.ok(year("2023-04-01", "2024-03-31")).await;
    h.ok(year("2025-04-01", "2026-03-31")).await;
    let mut r = h.store.reader().await.unwrap();
    let all = years::for_client(&mut r, &client_id).await.unwrap();
    assert_eq!(
        all.iter().map(|y| y.year.start()).collect::<Vec<_>>(),
        [date("2023-04-01"), date("2024-04-01"), date("2025-04-01")]
    );
}

#[tokio::test]
async fn years_pin_versions_and_revisions_dont_reach_back() {
    let h = Harness::new().await;
    let (template_id, mapping_id) = practice_defaults(&h).await;
    let client_id = create_client(&h).await;
    let y1 = create_year(&h, &client_id, "2024-04-01", "2025-03-31").await;

    let mut template: Template = serde_json::from_str(TEMPLATE).unwrap();
    template.name = "Company (revised)".into();
    let tv2 = h
        .ok(Command::ReviseTemplate {
            template_id: template_id.clone(),
            body: template,
        })
        .await;
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    let mv2 = h
        .ok(Command::ReviseMapping {
            mapping_id: mapping_id.clone(),
            body: mapping,
        })
        .await;

    // The next year copies its neighbour's pins; an explicit mapping pins the latest versions.
    let y2 = create_year(&h, &client_id, "2025-04-01", "2026-03-31").await;
    let y3 = h
        .ok(Command::CreateClientYear {
            client_id: client_id.clone(),
            start: date("2026-04-01"),
            end: date("2027-03-31"),
            mapping_id: Some(mapping_id.clone()),
        })
        .await;
    let mut r = h.store.reader().await.unwrap();
    let pins = |y: acct_store::years::StoredYear| (y.template_version_id, y.mapping_version_id);
    let p1 = pins(years::get(&mut r, &y1).await.unwrap().unwrap());
    let p2 = pins(years::get(&mut r, &y2).await.unwrap().unwrap());
    let p3 = pins(years::get(&mut r, &y3).await.unwrap().unwrap());
    assert_eq!(p1, p2);
    assert_eq!(p3, (tv2, mv2));
    assert_ne!(p1, p3);
}

#[tokio::test]
async fn a_first_year_needs_a_mapping_when_there_are_several() {
    let h = Harness::new().await;
    let (template_id, _) = practice_defaults(&h).await;
    let second = h
        .ok(Command::CreateMapping {
            template_id,
            name: "Company (alternative)".into(),
            body: serde_json::from_str(MAPPING).unwrap(),
        })
        .await;
    let client_id = create_client(&h).await;
    let year = |mapping_id: Option<String>| Command::CreateClientYear {
        client_id: client_id.clone(),
        start: date("2024-04-01"),
        end: date("2025-03-31"),
        mapping_id,
    };
    h.rejects(&master(), year(None), "mapping_required").await;
    h.ok(year(Some(second))).await;
}

#[tokio::test]
async fn bad_templates_and_mappings_are_rejected() {
    let h = Harness::new().await;
    let (template_id, _) = practice_defaults(&h).await;
    let mut mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    let mut overlapping = mapping.ranges[0].clone();
    overlapping.to = code("105");
    overlapping.from = code("105");
    mapping.ranges.push(overlapping);
    let err = h
        .rejects(
            &master(),
            Command::CreateMapping {
                template_id: template_id.clone(),
                name: "Bad".into(),
                body: mapping,
            },
            "invalid_mapping",
        )
        .await;
    assert_eq!(err.body().details[0]["code"], "overlap");

    let mut template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let first = template.statements[0].body[0].clone();
    template.statements[0].body.push(first);
    h.rejects(
        &master(),
        Command::ReviseTemplate {
            template_id,
            body: template,
        },
        "invalid_template",
    )
    .await;
    h.rejects(
        &master(),
        Command::CreateTemplate {
            entity_type: "Company".into(),
            name: "x".into(),
            body: serde_json::from_str(TEMPLATE).unwrap(),
        },
        "invalid_entity_type",
    )
    .await;
}

async fn chart_of(h: &Harness, client_id: &str) -> Vec<Account> {
    let mut r = h.store.reader().await.unwrap();
    clients::chart(&mut r, client_id)
        .await
        .unwrap()
        .accounts()
        .to_vec()
}

#[tokio::test]
async fn charts_are_edited_by_command() {
    let h = Harness::new().await;
    let (client_id, _) = company_with_year(&h).await;
    let add = |c: &str, name: &str| Command::AddAccount {
        client_id: client_id.clone(),
        account: Account {
            code: code(c),
            name: name.into(),
            account_type: acct_core::AccountType::Expense,
            active: true,
        },
    };
    let rename = |c: &str, name: &str| Command::RenameAccount {
        client_id: client_id.clone(),
        code: code(c),
        name: name.into(),
    };

    h.ok_none(add("236", "  Cleaning ")).await;
    let chart = chart_of(&h, &client_id).await;
    let cleaning = chart.iter().find(|a| a.code == code("236")).unwrap();
    assert_eq!(cleaning.name, "Cleaning");

    h.rejects(&master(), add("235", "Again"), "duplicate_account")
        .await;
    h.rejects(&master(), add("237", " "), "empty_name").await;
    h.rejects(&as_role(Role::Viewer), add("237", "X"), "forbidden")
        .await;
    h.rejects(
        &master(),
        Command::AddAccount {
            client_id: "nope".into(),
            account: chart[0].clone(),
        },
        "not_found",
    )
    .await;

    let before = chart_of(&h, &client_id).await;
    h.rejects(&master(), rename("999", "X"), "unknown_account")
        .await;
    h.rejects(&master(), rename("235", ""), "empty_name").await;
    h.rejects(&as_role(Role::Viewer), rename("235", "X"), "forbidden")
        .await;
    assert_eq!(chart_of(&h, &client_id).await, before);

    h.run_as(&as_role(Role::Staff), rename("235", "Repairs"))
        .await
        .unwrap();
    let after = chart_of(&h, &client_id).await;
    let repairs = after.iter().find(|a| a.code == code("235")).unwrap();
    assert_eq!(repairs.name, "Repairs");
    assert_eq!(repairs.account_type, acct_core::AccountType::Expense);
}

#[tokio::test]
async fn rounding_priority_lists_are_checked() {
    let h = Harness::new().await;
    let (client_id, _) = company_with_year(&h).await;
    let set = |codes: Vec<&str>| Command::SetRoundingPriority {
        client_id: client_id.clone(),
        rounding_priority: codes.into_iter().map(code).collect(),
    };
    let err = h
        .rejects(
            &master(),
            set(vec!["205", "999", "205"]),
            "invalid_rounding_priority",
        )
        .await;
    assert_eq!(err.body().details.as_array().unwrap().len(), 2);
    h.ok_none(set(vec!["290", "205"])).await;
    let mut r = h.store.reader().await.unwrap();
    let client = clients::get(&mut r, &client_id).await.unwrap().unwrap();
    assert_eq!(client.rounding_priority, [code("290"), code("205")]);
}

#[tokio::test]
async fn accounts_in_use_stay_active() {
    let h = Harness::new().await;
    let (client_id, y1) = company_with_year(&h).await;
    let set_active = |c: &str, active: bool| Command::SetAccountActive {
        client_id: client_id.clone(),
        code: code(c),
        active,
    };
    h.ok(journal_on(
        &y1,
        "2024-06-30",
        vec![line("600", 10_000), line("100", -10_000)],
    ))
    .await;

    let err = h
        .rejects(&master(), set_active("600", false), "account_in_use")
        .await;
    assert_eq!(err.body().details[0]["client_year_id"], y1.as_str());
    h.rejects(&master(), set_active("960", false), "account_in_use")
        .await;
    h.rejects(&master(), set_active("999", false), "unknown_account")
        .await;

    // Once FY2025 is finalised, sales (P&L) have no balance in an open year, but the bank
    // balance rolls into FY2026.
    let y2 = create_year(&h, &client_id, "2025-04-01", "2026-03-31").await;
    {
        let mut w = h.store.writer().await;
        acct_store::sqlx::query("UPDATE client_years SET status = 'finalised' WHERE id = ?")
            .bind(&y1)
            .execute(&mut *w)
            .await
            .unwrap();
    }
    let err = h
        .rejects(&master(), set_active("600", false), "account_in_use")
        .await;
    assert_eq!(err.body().details[0]["client_year_id"], y2.as_str());
    h.ok_none(set_active("100", false)).await;

    // An inactive account takes no journals until it's made active again.
    h.rejects(
        &master(),
        journal_on(&y2, "2025-06-30", vec![line("600", 500), line("100", -500)]),
        "invalid_journal",
    )
    .await;
    h.ok_none(set_active("100", true)).await;
    h.ok(journal_on(
        &y2,
        "2025-06-30",
        vec![line("600", 500), line("100", -500)],
    ))
    .await;
}
