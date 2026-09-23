//! Structured errors: every failure the API reports is `{ code, message, details }`.

use acct_store::StoreError;
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};
use ts_rs::TS;

/// The JSON body of every error response.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ApiError {
    /// A stable snake_case code the UI can switch on.
    pub code: String,
    /// A sentence for people.
    pub message: String,
    /// Structured specifics, such as each journal problem found. `null` if there are none.
    #[ts(type = "unknown")]
    pub details: Value,
}

/// Why a command was rejected. Nothing it did is kept.
#[derive(Debug)]
pub enum CommandError {
    /// The body isn't a command this server understands.
    Malformed(String),
    /// No valid session: not logged in, or the login has expired.
    Unauthenticated,
    /// A login with the wrong username or password. Which one is never said.
    BadCredentials,
    Forbidden,
    NotFound {
        entity: &'static str,
        id: String,
    },
    /// The `id` was already used for a different command.
    IdReused(String),
    /// The command breaks a domain rule. `details` lists the specifics.
    Invalid {
        code: &'static str,
        message: String,
        details: Value,
    },
    Store(StoreError),
}

impl From<StoreError> for CommandError {
    fn from(e: StoreError) -> CommandError {
        CommandError::Store(e)
    }
}

impl From<acct_store::sqlx::Error> for CommandError {
    fn from(e: acct_store::sqlx::Error) -> CommandError {
        CommandError::Store(e.into())
    }
}

impl CommandError {
    pub fn invalid(code: &'static str, message: impl Into<String>) -> CommandError {
        CommandError::Invalid {
            code,
            message: message.into(),
            details: Value::Null,
        }
    }

    pub fn invalid_with(
        code: &'static str,
        message: impl Into<String>,
        details: impl Serialize,
    ) -> CommandError {
        CommandError::Invalid {
            code,
            message: message.into(),
            details: serde_json::to_value(details).expect("error details serialise"),
        }
    }

    pub fn not_found(entity: &'static str, id: &str) -> CommandError {
        CommandError::NotFound {
            entity,
            id: id.to_owned(),
        }
    }

    pub fn status(&self) -> StatusCode {
        match self {
            CommandError::Malformed(_) => StatusCode::BAD_REQUEST,
            CommandError::Unauthenticated | CommandError::BadCredentials => {
                StatusCode::UNAUTHORIZED
            }
            CommandError::Forbidden => StatusCode::FORBIDDEN,
            CommandError::NotFound { .. } => StatusCode::NOT_FOUND,
            CommandError::IdReused(_) => StatusCode::CONFLICT,
            CommandError::Invalid { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            CommandError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn body(&self) -> ApiError {
        let (code, message, details) = match self {
            CommandError::Malformed(m) => ("malformed", m.clone(), Value::Null),
            CommandError::Unauthenticated => {
                ("unauthenticated", "Please log in.".to_owned(), Value::Null)
            }
            CommandError::BadCredentials => (
                "bad_credentials",
                "That username and password don't match.".to_owned(),
                Value::Null,
            ),
            CommandError::Forbidden => (
                "forbidden",
                "Your role doesn't allow this.".to_owned(),
                Value::Null,
            ),
            CommandError::NotFound { entity, id } => (
                "not_found",
                format!("There's no {entity} with id {id}."),
                json!({ "entity": entity, "id": id }),
            ),
            CommandError::IdReused(id) => (
                "id_reused",
                format!("The command id {id} was already used for a different command."),
                Value::Null,
            ),
            CommandError::Invalid {
                code,
                message,
                details,
            } => (*code, message.clone(), details.clone()),
            CommandError::Store(e) => {
                tracing::error!("store error: {e}");
                (
                    "internal",
                    "Something went wrong on the server. Nothing was saved.".to_owned(),
                    Value::Null,
                )
            }
        };
        ApiError {
            code: code.to_owned(),
            message,
            details,
        }
    }
}

impl IntoResponse for CommandError {
    fn into_response(self) -> Response {
        (self.status(), Json(self.body())).into_response()
    }
}
