//! Who's signed in now (M13), for the history panel.
//!
//! Each open browser sends `POST /api/presence` every few seconds, naming the business it's
//! showing, and gets back who else is here. Presence is kept in memory, not in the database: it
//! isn't practice data (CLAUDE.md hard rule 6), the server is one machine (ADR 008), and after a
//! restart everyone is back within one beat.

use std::collections::BTreeMap;
use std::sync::Mutex;

use acct_store::clients;
use acct_store::users::{self, Role};
use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::access;
use crate::auth::CurrentUser;
use crate::error::CommandError;

/// Someone counts as here if their browser was heard from this recently.
pub const HERE_FOR_SECS: i64 = 15;

#[derive(Debug, Clone)]
struct Seen {
    at: DateTime<Utc>,
    business_id: Option<String>,
}

/// When each user's browser was last heard from, and on which business.
#[derive(Debug, Default)]
pub struct Presence {
    seen: Mutex<BTreeMap<String, Seen>>,
}

impl Presence {
    /// Records that `user_id` is here now, looking at `business_id`, and returns everyone who's
    /// here, forgetting anyone who's gone quiet.
    fn beat(
        &self,
        user_id: &str,
        business_id: Option<String>,
        now: DateTime<Utc>,
    ) -> BTreeMap<String, (DateTime<Utc>, Option<String>)> {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.insert(
            user_id.to_owned(),
            Seen {
                at: now,
                business_id,
            },
        );
        let cutoff = now - TimeDelta::seconds(HERE_FOR_SECS);
        seen.retain(|_, s| s.at > cutoff);
        seen.iter()
            .map(|(id, s)| (id.clone(), (s.at, s.business_id.clone())))
            .collect()
    }

    /// Forgets `user_id`, when they sign out.
    pub fn leave(&self, user_id: &str) {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.remove(user_id);
    }
}

/// The body of `POST /api/presence`.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct PresenceBeat {
    /// The business the browser is showing, if any.
    #[serde(default)]
    #[ts(optional)]
    pub business_id: Option<String>,
}

/// Someone who's here now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct PresentUser {
    pub user_id: String,
    pub display_name: String,
    pub role: Role,
    /// The business they're looking at, if the viewer can see it too.
    pub business_id: Option<String>,
    pub business_name: Option<String>,
    #[ts(type = "string")]
    pub last_seen: DateTime<Utc>,
    pub is_you: bool,
}

/// `POST /api/presence`: "I'm here, on this business", answered with who's here.
///
/// You see someone if they're on a business you can see, or if you're both in the practice. An
/// owner sees who's on their own business. An overseer sees everyone. You always see yourself.
pub async fn post_presence(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Result<Json<PresenceBeat>, JsonRejection>,
) -> Result<Json<Vec<PresentUser>>, CommandError> {
    let Json(beat) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let mut conn = state.store.reader().await?;
    let actor = user.actor();
    let visible = access::visible(&mut conn, &actor).await?;
    if let Some(b) = &beat.business_id
        && !visible.shows(Some(b))
    {
        return Err(CommandError::not_found("business", b));
    }
    let here = state
        .presence
        .beat(&user.0.id, beat.business_id, Utc::now());

    let everyone = user.0.role == Role::Overseer;
    let mut out = Vec::new();
    for (id, (at, business_id)) in here {
        let Some(u) = users::get(&mut conn, &id).await?.filter(|u| u.active) else {
            continue;
        };
        let is_you = u.id == user.0.id;
        let business_id = business_id.filter(|b| visible.shows(Some(b)));
        let shown = is_you
            || everyone
            || business_id.is_some()
            || (user.0.role.is_practice() && u.role.is_practice());
        if !shown {
            continue;
        }
        let business_name = match &business_id {
            Some(b) => clients::get(&mut conn, b).await?.map(|c| c.name),
            None => None,
        };
        out.push(PresentUser {
            user_id: u.id,
            display_name: u.display_name,
            role: u.role,
            business_id,
            business_name,
            last_seen: at,
            is_you,
        });
    }
    out.sort_by(|a, b| {
        b.is_you
            .cmp(&a.is_you)
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    Ok(Json(out))
}
