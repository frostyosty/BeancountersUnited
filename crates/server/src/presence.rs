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
    /// The person an overseer is viewing as from this browser (M19), if they are.
    acting_as: Option<String>,
}

/// One browser heard from recently: when, on which business, and who it's viewing as.
type Here = (DateTime<Utc>, Option<String>, Option<String>);

/// When each user's browser was last heard from, and on which business.
#[derive(Debug, Default)]
pub struct Presence {
    seen: Mutex<BTreeMap<String, Seen>>,
}

impl Presence {
    /// Records that `user_id` is here now, looking at `business_id` (as `acting_as`, if an overseer
    /// is viewing as someone), and returns everyone who's here, forgetting anyone who's gone quiet.
    fn beat(
        &self,
        user_id: &str,
        business_id: Option<String>,
        acting_as: Option<String>,
        now: DateTime<Utc>,
    ) -> BTreeMap<String, Here> {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.insert(
            user_id.to_owned(),
            Seen {
                at: now,
                business_id,
                acting_as,
            },
        );
        let cutoff = now - TimeDelta::seconds(HERE_FOR_SECS);
        seen.retain(|_, s| s.at > cutoff);
        seen.iter()
            .map(|(id, s)| {
                (
                    id.clone(),
                    (s.at, s.business_id.clone(), s.acting_as.clone()),
                )
            })
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
    /// The person an overseer is viewing as (M19), by name. Then `display_name` reads "Olive
    /// (Overseer, as Sam Staff)", and `role` and `user_id` are still the overseer's. Always sent;
    /// optional in the type only so code that builds one needn't name it.
    #[ts(optional = nullable)]
    pub acting_as: Option<String>,
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
    // The overseer's own entry, even while viewing as someone: the beat is theirs, and Sam shows
    // as present only if Sam is signed in too (ADR 013, 7).
    let real = user.real();
    let acting_as = user.acting().map(|_| user.0.id.clone());
    let here = state
        .presence
        .beat(&real.id, beat.business_id, acting_as, Utc::now());

    // What the viewer sees is decided as the user they answer as (`visible` above), so an entry
    // viewing as Sam is shown to whoever could see Sam there, and to every overseer.
    let everyone = user.0.role == Role::Overseer;
    let mut out = Vec::new();
    for (id, (at, business_id, acting)) in here {
        let Some(u) = users::get(&mut conn, &id).await?.filter(|u| u.active) else {
            continue;
        };
        let person = match &acting {
            Some(p) => users::get(&mut conn, p).await?,
            None => None,
        };
        let is_you = u.id == real.id;
        let business_id = business_id.filter(|b| visible.shows(Some(b)));
        let subject_role = person.as_ref().map_or(u.role, |p| p.role);
        let shown = is_you
            || everyone
            || business_id.is_some()
            || (user.0.role.is_practice() && subject_role.is_practice());
        if !shown {
            continue;
        }
        let business_name = match &business_id {
            Some(b) => clients::get(&mut conn, b).await?.map(|c| c.name),
            None => None,
        };
        let display_name = match &person {
            Some(p) => format!(
                "{} ({}, as {})",
                u.display_name,
                role_name(u.role),
                p.display_name
            ),
            None => u.display_name,
        };
        out.push(PresentUser {
            user_id: u.id,
            display_name,
            role: u.role,
            business_id,
            business_name,
            last_seen: at,
            is_you,
            acting_as: person.map(|p| p.display_name),
        });
    }
    out.sort_by(|a, b| {
        b.is_you
            .cmp(&a.is_you)
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    Ok(Json(out))
}

/// A role as it reads in "Olive (Overseer, as Sam Staff)".
fn role_name(role: Role) -> &'static str {
    match role {
        Role::Overseer => "Overseer",
        Role::PracticeAdmin => "Practice admin",
        Role::Staff => "Staff",
        Role::Viewer => "Viewer",
        Role::BusinessOwner => "Business owner",
    }
}
