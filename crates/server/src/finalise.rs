//! Finalising and reopening years (M15), and serving what was signed.
//!
//! Finalising runs core's pre-checks ([`acct_core::finalise`]), stores a snapshot and locks the
//! year. A locked year's numbers can't change: the pipeline rejects every command that would
//! change them (`pipeline::lock_rule` lists each command and why), and [`ensure_open`] stops any
//! journal reaching a finalised year whichever path posts it.

use acct_core::TrialBalance;
use acct_core::finalise::{
    FinaliseInput, FinaliseIssue, FinaliseProblem, PriorYear, check_finalise,
};
use acct_store::coding::LineStateKind;
use acct_store::snapshots::{self, Snapshot};
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{SqliteConnection, bank, coding, log, new_id, templates, users, years};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::AppState;
use crate::assets;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::ledger;

/// The response header carrying the snapshot's SHA-256, so a reader can check the bytes.
pub const SHA256_HEADER: &str = "x-report-sha256";

fn finalised_error() -> CommandError {
    CommandError::invalid(
        "year_finalised",
        "This year is finalised, so its numbers can't change.",
    )
}

/// Refuses if the year is finalised. Both journal-posting paths call this, so nothing posts into
/// a locked year, even through a command whose own checks missed it.
pub(crate) async fn ensure_open(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<(), CommandError> {
    let year = years::get(conn, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", client_year_id))?;
    if year.status == YearStatus::Finalised {
        return Err(finalised_error());
    }
    Ok(())
}

/// Refuses an asset acquired on or before the end of a finalised year: holding it there would
/// change that year's register.
pub(crate) async fn ensure_register_open(
    conn: &mut SqliteConnection,
    client_id: &str,
    acquired: chrono::NaiveDate,
) -> Result<(), CommandError> {
    let locked = years::for_client(conn, client_id)
        .await?
        .into_iter()
        .any(|y| y.status == YearStatus::Finalised && acquired <= y.year.end());
    if locked {
        return Err(CommandError::invalid(
            "year_finalised",
            format!(
                "An asset acquired on {acquired} would be held in a finalised year, so it can't be \
                 added there. Reopen the year first."
            ),
        ));
    }
    Ok(())
}

/// The prior year's closing TB as comparatives show it: the snapshot's if the year is finalised,
/// else the live one.
pub(crate) async fn comparative_tb(
    conn: &mut SqliteConnection,
    prior: &StoredYear,
    live: &TrialBalance,
) -> Result<TrialBalance, CommandError> {
    if prior.status != YearStatus::Finalised {
        return Ok(live.clone());
    }
    match snapshots::latest(conn, &prior.id).await? {
        Some(s) => Ok(s.tb),
        None => Err(CommandError::Store(acct_store::StoreError::Corrupt(
            format!("finalised year {} has no snapshot", prior.id),
        ))),
    }
}

/// How many bank lines dated in the year are still unsorted.
async fn uncategorised_lines(
    conn: &mut SqliteConnection,
    year: &StoredYear,
) -> Result<u32, CommandError> {
    let states = coding::line_states(conn, &year.client_id).await?;
    let count = bank::bank_lines(conn, &year.client_id)
        .await?
        .iter()
        .filter(|l| year.year.contains(l.date))
        .filter(|l| {
            states
                .iter()
                .find(|s| s.bank_line_id == l.id)
                .is_none_or(|s| s.state == LineStateKind::Unsorted)
        })
        .count();
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// Core's pre-checks for finalising `year`, from the ledger as it stands, and the year's closing
/// TB they checked. The finalise command and the finalise screen's read both run this, so they
/// always agree.
async fn pre_checks(
    conn: &mut SqliteConnection,
    year: &StoredYear,
    accept_uncategorised: bool,
) -> Result<(TrialBalance, Vec<FinaliseProblem>), CommandError> {
    let (_, _, balances) = ledger::balances_to(conn, &year.id).await?;
    let current = balances.last().expect("the year itself");
    let prior = match balances.len().checked_sub(2).map(|i| &balances[i]) {
        Some(p) => Some((
            p.year.clone(),
            comparative_tb(conn, &p.year, &p.closing).await?,
        )),
        None => None,
    };
    let mapping = templates::mapping_version(conn, &year.mapping_version_id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping version", &year.mapping_version_id))?;
    let register = assets::load(conn, &year.client_id).await?;
    let i = register
        .year_index(&year.id)
        .expect("the year belongs to the client");
    let depreciation_current = assets::journals_match(
        &assets::current_journals(conn, &year.id).await?,
        &register.desired_journals(i),
    );
    let input = FinaliseInput {
        tb: &current.closing,
        prior: prior.as_ref().map(|(y, tb)| PriorYear {
            end: y.year.end(),
            finalised: y.status == YearStatus::Finalised,
            tb,
        }),
        mapping: &mapping.body,
        depreciation_current,
        uncategorised_lines: uncategorised_lines(conn, year).await?,
        accept_uncategorised,
    };
    let problems = check_finalise(&input);
    Ok((current.closing.clone(), problems))
}

/// `finalise_year`. Returns the new snapshot's id.
pub(crate) async fn finalise(
    tx: &mut SqliteConnection,
    seq: i64,
    by: &str,
    client_year_id: &str,
    accept_uncategorised: bool,
) -> Result<String, CommandError> {
    let year = years::get(tx, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", client_year_id))?;
    if year.status == YearStatus::Finalised {
        return Err(CommandError::invalid(
            "year_finalised",
            "This year is already finalised.",
        ));
    }
    let (closing, problems) = pre_checks(tx, &year, accept_uncategorised).await?;
    if !problems.is_empty() {
        let issues: Vec<FinaliseIssue> = problems.into_iter().map(FinaliseIssue::from).collect();
        let message = issues
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        return Err(CommandError::invalid_with(
            "not_ready_to_finalise",
            format!("This year can't be finalised yet. {message}"),
            issues,
        ));
    }

    let doc = ledger::report(tx, client_year_id).await?;
    let report_doc = serde_json::to_string(&doc).expect("ReportDocs serialise");
    let id = new_id();
    snapshots::insert(
        tx,
        &Snapshot {
            id: id.clone(),
            client_year_id: year.id.clone(),
            tb: closing,
            template_version_id: year.template_version_id.clone(),
            mapping_version_id: year.mapping_version_id.clone(),
            report_sha256: sha256_hex(report_doc.as_bytes()),
            report_doc,
            finalised_seq: seq,
            finalised_by: by.to_owned(),
        },
    )
    .await?;
    years::set_status(tx, &year.id, YearStatus::Finalised).await?;
    Ok(id)
}

/// `reopen_year`. The reason is kept in the command's log entry; the snapshots stay.
pub(crate) async fn reopen(
    tx: &mut SqliteConnection,
    client_year_id: &str,
    reason: &str,
) -> Result<StoredYear, CommandError> {
    let year = years::get(tx, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", client_year_id))?;
    if year.status != YearStatus::Finalised {
        return Err(CommandError::invalid(
            "year_not_finalised",
            "This year isn't finalised, so there's nothing to reopen.",
        ));
    }
    if reason.trim().is_empty() {
        return Err(CommandError::invalid(
            "reason_required",
            "Say why the year is being reopened. The reason is kept in its history.",
        ));
    }
    // Finalised years run unbroken from the first, so this year's closing balances (the next
    // year's opening) stay fixed while a later year is finalised.
    let later = years::for_client(tx, &year.client_id)
        .await?
        .into_iter()
        .find(|y| y.year.start() > year.year.start() && y.status == YearStatus::Finalised);
    if let Some(later) = later {
        return Err(CommandError::invalid(
            "later_year_finalised",
            format!(
                "The year ending {} is finalised too. Reopen it first.",
                later.year.end()
            ),
        ));
    }
    years::set_status(tx, &year.id, YearStatus::Open).await?;
    Ok(year)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The ReportDoc JSON a finalised year was signed with, and its SHA-256, exactly as stored.
pub async fn signed_report(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<(String, String), CommandError> {
    let year = years::get(conn, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", client_year_id))?;
    if year.status != YearStatus::Finalised {
        return Err(CommandError::invalid(
            "year_not_finalised",
            "This year isn't finalised, so it has no signed statements yet.",
        ));
    }
    let snapshot = snapshots::latest(conn, client_year_id)
        .await?
        .ok_or_else(|| {
            CommandError::Store(acct_store::StoreError::Corrupt(format!(
                "finalised year {client_year_id} has no snapshot"
            )))
        })?;
    Ok((snapshot.report_doc, snapshot.report_sha256))
}

/// `GET /api/years/{id}/snapshot`: the signed ReportDoc, byte for byte as stored. Never rebuilt.
pub async fn get_snapshot(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Response, CommandError> {
    let mut conn = state.store.reader().await?;
    let (doc, sha) = signed_report(&mut conn, &id).await?;
    let mut response = doc.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        SHA256_HEADER,
        HeaderValue::from_str(&sha).expect("hex is a valid header value"),
    );
    Ok(response)
}

/// Who signed a finalised year off, when, and the hash of what they signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FinalisedBy {
    /// The person's display name.
    pub who: String,
    /// When the finalise command was accepted (UTC, RFC 3339).
    #[ts(type = "string")]
    pub at: DateTime<Utc>,
    pub seq: i64,
    /// SHA-256 of the signed ReportDoc's JSON, as lowercase hex.
    pub sha256: String,
}

/// The finalise screen's read: the pre-checks as they stand, and who finalised the year if it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FinaliseCheck {
    pub status: YearStatus,
    /// Whether there's an earlier year, so the "prior year finalised" check applies.
    pub has_prior_year: bool,
    /// Every pre-check that fails now, uncategorised bank lines included (finalising can still
    /// accept those as they are). Empty for a finalised year.
    pub issues: Vec<FinaliseIssue>,
    /// Bank lines dated in the year that are still unsorted.
    pub uncategorised_lines: u32,
    /// Set when the year is finalised: its latest snapshot.
    pub finalised: Option<FinalisedBy>,
}

/// `GET /api/years/{id}/finalise-check`: runs the pre-checks without finalising.
pub async fn get_finalise_check(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<FinaliseCheck>, CommandError> {
    let mut conn = state.store.reader().await?;
    let year = years::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", &id))?;
    let has_prior_year = years::for_client(&mut conn, &year.client_id)
        .await?
        .iter()
        .any(|y| y.year.start() < year.year.start());
    let uncategorised = uncategorised_lines(&mut conn, &year).await?;
    if year.status == YearStatus::Finalised {
        let snapshot = snapshots::latest(&mut conn, &id).await?.ok_or_else(|| {
            CommandError::Store(acct_store::StoreError::Corrupt(format!(
                "finalised year {id} has no snapshot"
            )))
        })?;
        let who = users::get(&mut conn, &snapshot.finalised_by)
            .await?
            .map_or_else(|| "someone".to_owned(), |u| u.display_name);
        let logged = log::after(&mut conn, snapshot.finalised_seq - 1, 1).await?;
        let at = logged
            .first()
            .filter(|c| c.seq == snapshot.finalised_seq)
            .map(|c| c.at)
            .ok_or_else(|| {
                CommandError::Store(acct_store::StoreError::Corrupt(format!(
                    "snapshot {} has no command log entry",
                    snapshot.id
                )))
            })?;
        return Ok(Json(FinaliseCheck {
            status: year.status,
            has_prior_year,
            issues: Vec::new(),
            uncategorised_lines: uncategorised,
            finalised: Some(FinalisedBy {
                who,
                at,
                seq: snapshot.finalised_seq,
                sha256: snapshot.report_sha256,
            }),
        }));
    }
    let (_, problems) = pre_checks(&mut conn, &year, false).await?;
    Ok(Json(FinaliseCheck {
        status: year.status,
        has_prior_year,
        issues: problems.into_iter().map(FinaliseIssue::from).collect(),
        uncategorised_lines: uncategorised,
        finalised: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::sha256_hex;

    #[test]
    fn sha256_is_lowercase_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
