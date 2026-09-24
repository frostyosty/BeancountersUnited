//! Trial balances from stored journals. Opening balances are computed by rolling each year into
//! the next, never posted (CLAUDE.md, Rollover).

use acct_core::{Chart, Journal, ReportDoc, ReportInput, TrialBalance, build_report, rollover};
use acct_store::clients::Client;
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{SqliteConnection, clients, journals, templates, years};
use serde_json::json;

use crate::error::CommandError;

/// One year's balances.
pub struct YearBalances {
    pub year: StoredYear,
    pub opening: TrialBalance,
    pub closing: TrialBalance,
}

/// Every year of a client, earliest first, with opening and closing balances.
pub async fn client_balances(
    conn: &mut SqliteConnection,
    client: &Client,
    chart: &Chart,
) -> Result<Vec<YearBalances>, CommandError> {
    let mut out: Vec<YearBalances> = Vec::new();
    for year in years::for_client(conn, &client.id).await? {
        let opening = match out.last() {
            None => TrialBalance::default(),
            Some(prior) => {
                rollover(&prior.closing, chart, &client.retained_earnings).map_err(|e| {
                    CommandError::invalid("rollover_failed", format!("Rolling forward: {e}"))
                })?
            }
        };
        let posted: Vec<Journal> = journals::for_year(conn, &year.id)
            .await?
            .into_iter()
            .map(|j| j.journal)
            .collect();
        let closing = TrialBalance::from_journals(&opening, &posted);
        out.push(YearBalances {
            year,
            opening,
            closing,
        });
    }
    Ok(out)
}

/// The client that owns a year, the client's chart, and the balances of every year up to and
/// including it. The year asked for is last.
pub async fn balances_to(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<(Client, Chart, Vec<YearBalances>), CommandError> {
    let year = years::get(conn, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", client_year_id))?;
    let client = clients::get(conn, &year.client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &year.client_id))?;
    let chart = clients::chart(conn, &client.id).await?;
    let mut all = client_balances(conn, &client, &chart).await?;
    let end = all
        .iter()
        .position(|b| b.year.id == client_year_id)
        .expect("the year belongs to the client");
    all.truncate(end + 1);
    Ok((client, chart, all))
}

/// Builds a year's statements through its pinned template and mapping, with the prior year's
/// closing balances as comparatives.
///
/// Until finalisation exists (M5), comparatives always come from the prior year's live balances.
pub async fn report(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<ReportDoc, CommandError> {
    let (client, _, balances) = balances_to(conn, client_year_id).await?;
    let [.., prior, current] = balances.as_slice() else {
        return build(
            conn,
            &client,
            balances.last().expect("the year itself"),
            None,
        )
        .await;
    };
    build(conn, &client, current, Some(prior)).await
}

async fn build(
    conn: &mut SqliteConnection,
    client: &Client,
    current: &YearBalances,
    prior: Option<&YearBalances>,
) -> Result<ReportDoc, CommandError> {
    let template = templates::template_version(conn, &current.year.template_version_id)
        .await?
        .ok_or_else(|| {
            CommandError::not_found("template version", &current.year.template_version_id)
        })?;
    let mapping = templates::mapping_version(conn, &current.year.mapping_version_id)
        .await?
        .ok_or_else(|| {
            CommandError::not_found("mapping version", &current.year.mapping_version_id)
        })?;
    let input = ReportInput {
        template: &template.body,
        mapping: &mapping.body,
        year: &current.year.year,
        tb: &current.closing,
        prior: prior.map(|p| acct_core::Prior {
            year: &p.year.year,
            tb: &p.closing,
            finalised: p.year.status == YearStatus::Finalised,
        }),
        rounding_priority: &client.rounding_priority,
    };
    let mut doc = build_report(&input).map_err(|errors| {
        let details: Vec<serde_json::Value> = errors
            .iter()
            .map(|e| match e {
                acct_core::BuildError::Mapping(m) => serde_json::to_value(m).expect("serialises"),
                other => json!({ "code": "build", "message": other.to_string() }),
            })
            .collect();
        CommandError::invalid_with(
            "report_failed",
            "The statements can't be built until these are fixed.",
            details,
        )
    })?;
    let register = crate::assets::load(conn, &client.id).await?;
    let i = register
        .year_index(&current.year.id)
        .expect("the year belongs to the client");
    doc.asset_schedule = register.schedule(i);
    Ok(doc)
}
