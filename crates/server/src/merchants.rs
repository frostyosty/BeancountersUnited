//! The practice's merchant list (ADR 009's layer 3): description patterns that suggest a
//! category, such as "Z ENERGY is vehicle costs". One list per entity type, kept by the practice
//! owner, from synthetic or consented data only. Save tax consults it after the business's rules
//! and history and before any AI model. It only ever suggests: a change never touches coded lines.

use acct_core::coding::{Coding, DepositCoding, Merchant, WithdrawalCoding};
use acct_core::{AccountCode, AccountType, GstCode};
use acct_store::merchants::{self as store};
use acct_store::{SqliteConnection, charts, new_id};
use axum::Json;
use axum::extract::{Path, State};

use crate::AppState;
use crate::ai::suggestible;
use crate::auth::CurrentUser;
use crate::error::CommandError;

/// `add_merchant`. Returns the entry's id.
pub async fn add_merchant(
    tx: &mut SqliteConnection,
    seq: i64,
    entity_type: &str,
    description_contains: &str,
    coding: &Coding,
) -> Result<String, CommandError> {
    let chart = charts::for_entity_type(tx, entity_type)
        .await?
        .ok_or_else(|| CommandError::not_found("master chart", entity_type))?
        .chart;
    let pattern = description_contains
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase();
    if pattern.chars().filter(|c| c.is_alphanumeric()).count() < 3 {
        return Err(CommandError::invalid(
            "pattern_too_short",
            "A merchant's pattern needs at least 3 letters or digits.",
        ));
    }
    if !suggestible(coding) {
        return Err(CommandError::invalid(
            "not_suggestible",
            "A merchant can suggest a category, personal spending or money that isn't income.",
        ));
    }
    let account = |code: &AccountCode, wanted: AccountType| match chart.get(code) {
        Some(a) if a.active && a.account_type == wanted => Ok(()),
        _ => Err(CommandError::invalid(
            "invalid_coding",
            format!(
                "Account {code} isn't an active {} account in the master chart.",
                match wanted {
                    AccountType::Income => "income",
                    _ => "expense",
                }
            ),
        )),
    };
    match coding {
        Coding::In(DepositCoding::Income { account: a, gst }) => {
            account(a, AccountType::Income)?;
            if *gst == GstCode::None {
                return Err(CommandError::invalid(
                    "invalid_coding",
                    "Income can be standard, zero-rated or exempt, but not outside GST.",
                ));
            }
        }
        Coding::Out(WithdrawalCoding::Expense { account: a, .. }) => {
            account(a, AccountType::Expense)?;
        }
        _ => {}
    }
    let live = store::live(tx, entity_type).await?;
    if live
        .iter()
        .any(|m| m.description_contains == pattern && m.coding.direction() == coding.direction())
    {
        return Err(CommandError::invalid(
            "merchant_exists",
            "That pattern is already on the list. Remove it first to change it.",
        ));
    }
    let id = new_id();
    store::insert(
        tx,
        entity_type,
        &Merchant {
            id: id.clone(),
            description_contains: pattern,
            coding: coding.clone(),
        },
        seq,
    )
    .await?;
    Ok(id)
}

/// The live entries on an entity type's list that code to `code`.
pub async fn using_account(
    tx: &mut SqliteConnection,
    entity_type: &str,
    code: &AccountCode,
) -> Result<Vec<Merchant>, CommandError> {
    Ok(store::live(tx, entity_type)
        .await?
        .into_iter()
        .filter(|m| coded_account(&m.coding) == Some(code))
        .collect())
}

/// The account a merchant entry codes to, if it names one.
fn coded_account(coding: &Coding) -> Option<&AccountCode> {
    match coding {
        Coding::In(DepositCoding::Income { account, .. })
        | Coding::Out(WithdrawalCoding::Expense { account, .. }) => Some(account),
        _ => None,
    }
}

/// `remove_merchant`.
pub async fn remove_merchant(
    tx: &mut SqliteConnection,
    seq: i64,
    merchant_id: &str,
) -> Result<(), CommandError> {
    let found = store::get(tx, merchant_id)
        .await?
        .filter(|m| m.removed_seq.is_none())
        .ok_or_else(|| CommandError::not_found("merchant", merchant_id))?;
    store::remove(tx, &found.merchant.id, seq).await?;
    Ok(())
}

/// `GET /api/merchants/{entity_type}`: an entity type's merchant list, oldest first.
pub async fn get_merchants(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(entity_type): Path<String>,
) -> Result<Json<Vec<Merchant>>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(store::live(&mut conn, &entity_type).await?))
}
