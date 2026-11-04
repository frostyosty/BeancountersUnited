//! The three example statements on the home page (M20, `fixtures/landing/README.md`).
//!
//! The files are embedded. Each example carries what a visitor sees before choosing it (the bank,
//! the business, the parsed lines, the raw text) and the conservative "tax to pay" figure a guest
//! gets from it. That figure comes from the path a guest takes (ADR 014, 9): a throwaway store gets
//! the sole-trader starter set, `start_guest` sets the example's business up from its file by the
//! same rules as anyone's own (books from 1 April, GST detected from the lines or else assumed)
//! and imports it, and `save_tax::queue` reads the figure. The setup shown is read back from that
//! store too. Nothing here works out a tax amount or a setup itself.
//!
//! `GET /api/examples` is public: the examples are synthetic and the same for everyone.

use std::path::PathBuf;

use acct_core::Money;
use acct_import::bank::{decode, read_statement};
use acct_store::Store;
use axum::Json;
use axum::http::header::{CACHE_CONTROL, HeaderValue};
use axum::response::{IntoResponse, Response};
use chrono::{NaiveDate, Utc};
use serde::Serialize;
use tokio::sync::OnceCell;
use ts_rs::TS;

use crate::business::{GstBasis, GstSetup};
use crate::commands::{Accepted, Command, CommandEnvelope, GuestSource};
use crate::error::CommandError;
use crate::pipeline::{Actor, submit};
use crate::save_tax;
use crate::starter::StarterSet;
use acct_store::users::Role;

/// What is fixed about one example: its file and the business it belongs to. How it's set up
/// (start date, GST) isn't here: it comes from the file, as a guest's own would.
struct Spec {
    number: u8,
    business: &'static str,
    what: &'static str,
    bank: &'static str,
    file_name: &'static str,
    bytes: &'static [u8],
}

const SPECS: [Spec; 3] = [
    Spec {
        number: 1,
        business: "Tūī Street Coffee",
        what: "a coffee cart",
        bank: "Piwakawaka Bank",
        file_name: "example-1-tui-street-coffee-2025-10.ofx",
        bytes: include_bytes!("../../../fixtures/landing/example-1-tui-street-coffee-2025-10.ofx"),
    },
    Spec {
        number: 2,
        business: "Matai Design Studio",
        what: "a freelance designer",
        bank: "Tōtara Mutual Bank",
        file_name: "example-2-matai-design-2025-08_09.ofx",
        bytes: include_bytes!("../../../fixtures/landing/example-2-matai-design-2025-08_09.ofx"),
    },
    Spec {
        number: 3,
        business: "Kahu Electrical",
        what: "an electrician",
        bank: "Kea Trust Bank",
        file_name: "example-3-kahu-electrical-2025-07_09.ofx",
        bytes: include_bytes!("../../../fixtures/landing/example-3-kahu-electrical-2025-07_09.ofx"),
    },
];

fn spec(number: u8) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.number == number)
}

/// An example's business name, file name and bytes, for a guest who uses it (M20, ADR 014, 9):
/// the server imports its own copy, so the browser never sends it.
pub fn example_file(number: u8) -> Option<(&'static str, &'static str, &'static [u8])> {
    spec(number).map(|s| (s.business, s.file_name, s.bytes))
}

/// One line of an example, as the parser gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ExampleLine {
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub description: String,
    /// Money in is positive.
    pub amount: Money,
}

/// An example statement, for the home page's cards and full-screen preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ExampleStatement {
    /// 1 to 3.
    pub number: u8,
    /// "Example 1".
    pub title: String,
    /// "Tūī Street Coffee".
    pub business: String,
    /// "a coffee cart".
    pub what: String,
    pub bank: String,
    pub file_name: String,
    pub account_number: String,
    /// The day the business starts in the books, as a guest's would: 1 April of the income year
    /// holding the statement's first line (ADR 014, 3).
    #[ts(type = "string")]
    pub start_date: NaiveDate,
    /// Whether the business is GST registered, and how it files. `None`: not registered.
    #[ts(optional)]
    pub gst: Option<GstSetup>,
    /// Where that registration came from: `detected` from a GST payment or refund in the lines,
    /// else `assumed`.
    pub gst_source: acct_store::guests::GstSource,
    #[ts(type = "string")]
    pub period_start: NaiveDate,
    #[ts(type = "string")]
    pub period_end: NaiveDate,
    /// The balance before the first line.
    pub opening_balance: Money,
    pub closing_balance: Money,
    pub lines: Vec<ExampleLine>,
    /// The file's own text.
    pub raw: String,
    /// "Tax to pay if submitted" for a fresh business with this file: every deposit counted as
    /// income and nothing claimed.
    pub conservative_tax: Money,
}

/// The command a visitor's "Use this example" sends, with no session: a guest whose business is
/// this example (ADR 014, 9).
pub fn start_command(number: u8) -> Option<Command> {
    spec(number)?;
    Some(Command::StartGuest {
        source: GuestSource::Example(number),
    })
}

/// What a guest gets from an example: the conservative figure and the setup.
struct Outcome {
    figure: Money,
    start_date: NaiveDate,
    gst: Option<GstSetup>,
    gst_source: acct_store::guests::GstSource,
}

/// Runs the example through a throwaway store as a guest would, and reads what they get.
async fn scratch_figure(number: u8) -> Result<Outcome, CommandError> {
    let io = |e: std::io::Error| CommandError::Malformed(format!("examples scratch store: {e}"));
    let dir: PathBuf = std::env::temp_dir().join(format!("acct-examples-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).map_err(io)?;
    let store = Store::open(&dir.join("examples.db")).await?;
    let figure = figure_in(&store, number).await;
    // The scratch store is only for this figure.
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
    figure
}

/// `scratch_figure` on a blocking thread: the pipeline's futures borrow the store in a way the
/// compiler can't prove `Send` when the store is a local, and `block_on` doesn't need that.
async fn conservative_tax(number: u8) -> Result<Outcome, CommandError> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || handle.block_on(scratch_figure(number)))
        .await
        .map_err(|e| CommandError::Malformed(format!("examples scratch store: {e}")))?
}

async fn run(store: &Store, role: Role, command: Command) -> Result<Accepted, CommandError> {
    let server = Actor {
        user_id: None,
        role,
        acting_as: None,
    };
    let envelope = CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command,
    };
    submit(store, &server, envelope, Utc::now()).await
}

async fn figure_in(store: &Store, number: u8) -> Result<Outcome, CommandError> {
    run(
        store,
        Role::PracticeAdmin,
        Command::InstallStarterSet {
            set: StarterSet::SoleTrader,
        },
    )
    .await?;
    // As a visitor with no session: the same command `POST /api/guest` submits.
    let client_id = run(
        store,
        Role::BusinessOwner,
        start_command(number).expect("a known example"),
    )
    .await?
    .entity_id
    .ok_or_else(|| CommandError::Malformed("the example made nothing".to_owned()))?;
    let mut conn = store.reader().await?;
    let business = crate::business::business(&mut conn, &client_id).await?;
    let gst_source = acct_store::guests::flags(&mut conn, &client_id)
        .await?
        .map_or(acct_store::guests::GstSource::Owner, |f| f.source());
    Ok(Outcome {
        figure: save_tax::queue(&mut conn, &client_id)
            .await?
            .conservative_total,
        start_date: business.start_date,
        gst: business.gst.map(|g| GstSetup {
            registered_from: g.registered_from,
            frequency: g.frequency,
            basis: GstBasis::Payments,
        }),
        gst_source,
    })
}

async fn build(spec: &'static Spec) -> Result<ExampleStatement, CommandError> {
    let statement =
        read_statement(spec.bytes).expect("the embedded examples parse (tests/landing_examples)");
    let (period_start, period_end) = (
        statement
            .period_start
            .expect("an example states its period"),
        statement.period_end.expect("an example states its period"),
    );
    let closing_balance = statement
        .closing
        .expect("an example states its closing balance")
        .amount;
    let total: Money = statement.lines.iter().map(|l| l.amount).sum();
    let outcome = conservative_tax(spec.number).await?;
    Ok(ExampleStatement {
        number: spec.number,
        title: format!("Example {}", spec.number),
        business: spec.business.to_owned(),
        what: spec.what.to_owned(),
        bank: spec.bank.to_owned(),
        file_name: spec.file_name.to_owned(),
        account_number: statement
            .account
            .clone()
            .expect("an example names its account"),
        start_date: outcome.start_date,
        gst: outcome.gst,
        gst_source: outcome.gst_source,
        period_start,
        period_end,
        opening_balance: closing_balance - total,
        closing_balance,
        lines: statement
            .lines
            .iter()
            .map(|l| ExampleLine {
                date: l.date,
                description: l.description.clone(),
                amount: l.amount,
            })
            .collect(),
        raw: decode(spec.bytes),
        conservative_tax: outcome.figure,
    })
}

static EXAMPLES: OnceCell<Vec<ExampleStatement>> = OnceCell::const_new();

/// The three examples, worked out once and kept for the life of the server.
pub async fn examples() -> Result<&'static [ExampleStatement], CommandError> {
    EXAMPLES
        .get_or_try_init(|| async {
            let mut all = Vec::with_capacity(SPECS.len());
            for spec in &SPECS {
                all.push(build(spec).await?);
            }
            Ok::<_, CommandError>(all)
        })
        .await
        .map(Vec::as_slice)
}

/// `GET /api/examples`: public, and cached by browsers for an hour.
pub async fn get_examples() -> Result<Response, CommandError> {
    let mut response = Json(examples().await?).into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    Ok(response)
}
