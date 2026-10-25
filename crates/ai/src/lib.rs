//! AI category suggestions (ADR 009): layer 4, for the bank lines the business's rules, its own
//! history and the practice's merchant list couldn't answer.
//!
//! - [`redact::request`] is the only way to build a [`SuggestRequest`], so nothing reaches a
//!   provider without going through redaction.
//! - [`Suggester`] is the trait the server holds. [`anthropic`] and [`openai_compatible`] are the
//!   HTTP adapters, and [`FakeSuggester`] is for tests and `acct-dev`.
//! - What comes back is a [`RawSuggestion`]: a reference into the request, a category key, a GST
//!   code and a confidence. The server validates it and turns it into a command; nothing here
//!   computes an amount.
//!
//! Errors and logs never contain request or response bodies.

pub mod anthropic;
pub mod eval;
mod fake;
#[cfg(test)]
mod leak_tests;
pub mod openai_compatible;
mod prompt;
pub mod redact;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use acct_core::GstCode;
use acct_core::coding::Direction;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use fake::{FakeAnswer, FakeSuggester};
pub use redact::SuggestRequest;

/// How sure the model is. [`Confidence::Low`] answers never pre-fill a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

/// One answer, as the model gave it. The server checks every field before using it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSuggestion {
    /// The line's reference within the request (1, 2, 3, ...).
    pub reference: u32,
    /// One of the request's category keys, if the model kept to them.
    pub category: String,
    pub gst: GstCode,
    pub confidence: Confidence,
}

/// A category the model may choose for lines of one direction: an account in the business's
/// chart (`key` is its code), or a kind of coding that names no account, such as `personal`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Category {
    pub key: String,
    pub name: String,
    pub direction: Direction,
}

/// Why a request got no suggestions. None of these carry a request or response body.
#[derive(Debug, Error)]
pub enum AiError {
    #[error("couldn't reach the AI service: {0}")]
    Network(String),
    #[error("the AI service answered with HTTP {0}")]
    Status(u16),
    #[error("the AI service declined the request")]
    Refused,
    #[error("the AI service's answer wasn't usable: {0}")]
    BadResponse(&'static str),
}

/// What a suggester's `suggest` returns.
pub type SuggestFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<RawSuggestion>, AiError>> + Send + 'a>>;

/// Something that suggests categories. The server holds an `Arc<dyn Suggester>`, chosen by
/// [`Config`].
pub trait Suggester: Send + Sync {
    /// The provider's name as Save tax and the privacy notice show it, such as `Anthropic`.
    fn provider(&self) -> &str;
    /// The model id recorded with each suggestion, such as `claude-haiku-5-5`.
    fn model(&self) -> &str;
    fn suggest(&self, request: SuggestRequest) -> SuggestFuture<'_>;
    /// The tokens used so far, as the provider reported them. `acctd ai-eval` prices them.
    fn usage(&self) -> Usage {
        Usage::default()
    }
}

/// Tokens used, added up over requests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub requests: u64,
    /// Input tokens read at the full price.
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Input tokens read from the provider's prompt cache.
    pub cache_read_tokens: u64,
    /// Input tokens written to the provider's prompt cache.
    pub cache_write_tokens: u64,
}

impl Usage {
    pub(crate) fn add(&mut self, other: Usage) {
        self.requests += other.requests;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
    }
}

fn count(v: &serde_json::Value, path: &[&str]) -> u64 {
    path.iter()
        .try_fold(v, |v, key| v.get(key))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

/// Which adapter to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAiCompatible,
    /// [`FakeSuggester`] with its default answers, for `acct-dev` and trying the screens out.
    /// Nothing leaves the machine.
    Fake,
}

/// The server's AI configuration: `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY` and, for
/// `openai_compatible`, `AI_PROVIDER_NAME`.
#[derive(Clone)]
pub struct Config {
    pub provider: Provider,
    /// The provider's name as Save tax shows it (`AI_PROVIDER_NAME`, needed for
    /// `openai_compatible`).
    pub provider_name: String,
    pub model: String,
    pub base_url: String,
    api_key: String,
}

// Never print the key.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("provider", &self.provider)
            .field("provider_name", &self.provider_name)
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

/// The model development starts on (ADR 009). The bake-off chooses the production one.
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-haiku-5-5";

impl Config {
    /// Reads the configuration through `var` (the server passes the environment). `Ok(None)`
    /// means no suggester: no provider, or no key. Save tax then simply shows no AI suggestions.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Option<Config>, String> {
        let get = |name: &str| {
            var(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let Some(provider) = get("AI_PROVIDER") else {
            return Ok(None);
        };
        let provider = match provider.as_str() {
            "anthropic" => Provider::Anthropic,
            "openai_compatible" => Provider::OpenAiCompatible,
            "fake" => Provider::Fake,
            other => {
                return Err(format!(
                    "AI_PROVIDER is {other:?}; use anthropic, openai_compatible or fake"
                ));
            }
        };
        if provider == Provider::Fake {
            return Ok(Some(Config {
                provider,
                provider_name: "a test service".to_owned(),
                model: get("AI_MODEL").unwrap_or_else(|| "fake".to_owned()),
                base_url: String::new(),
                api_key: String::new(),
            }));
        }
        let Some(api_key) = get("AI_API_KEY") else {
            return Ok(None);
        };
        let (provider_name, model, base_url) = match provider {
            Provider::Anthropic => (
                "Anthropic".to_owned(),
                get("AI_MODEL").unwrap_or_else(|| DEFAULT_ANTHROPIC_MODEL.to_owned()),
                get("AI_BASE_URL").unwrap_or_else(|| anthropic::DEFAULT_BASE_URL.to_owned()),
            ),
            _ => (
                get("AI_PROVIDER_NAME")
                    .ok_or("AI_PROVIDER_NAME is needed for openai_compatible")?,
                get("AI_MODEL").ok_or("AI_MODEL is needed for openai_compatible")?,
                get("AI_BASE_URL").ok_or("AI_BASE_URL is needed for openai_compatible")?,
            ),
        };
        Ok(Some(Config {
            provider,
            provider_name,
            model,
            base_url,
            api_key,
        }))
    }

    /// The suggester this configuration names.
    pub fn suggester(&self) -> Result<Arc<dyn Suggester>, AiError> {
        Ok(match self.provider {
            Provider::Fake => Arc::new(FakeSuggester::with_defaults(&self.model)),
            Provider::Anthropic => Arc::new(anthropic::Client::new(
                http()?,
                &self.base_url,
                &self.model,
                &self.api_key,
            )),
            Provider::OpenAiCompatible => Arc::new(openai_compatible::Client::new(
                &self.provider_name,
                http()?,
                &self.base_url,
                &self.model,
                &self.api_key,
            )),
        })
    }
}

fn http() -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AiError::Network(e.to_string()))
}

/// Sends `body` and returns the response's JSON. The body never appears in an error.
async fn post_json(
    request: reqwest::RequestBuilder,
    body: &serde_json::Value,
) -> Result<serde_json::Value, AiError> {
    let response = request
        .json(body)
        .send()
        .await
        .map_err(|e| AiError::Network(e.without_url().to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AiError::Status(status.as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| AiError::BadResponse("the response wasn't JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn no_provider_or_no_key_means_no_suggester() {
        assert!(Config::from_vars(vars(&[])).unwrap().is_none());
        assert!(
            Config::from_vars(vars(&[("AI_PROVIDER", "anthropic")]))
                .unwrap()
                .is_none()
        );
        assert!(
            Config::from_vars(vars(&[("AI_PROVIDER", "anthropic"), ("AI_API_KEY", "  ")]))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn anthropic_defaults_to_haiku() {
        let c = Config::from_vars(vars(&[("AI_PROVIDER", "anthropic"), ("AI_API_KEY", "k")]))
            .unwrap()
            .unwrap();
        assert_eq!(c.model, "claude-haiku-5-5");
        assert_eq!(c.base_url, "https://api.anthropic.com");
    }

    #[test]
    fn openai_compatible_needs_a_model_and_base_url() {
        let only_key = [("AI_PROVIDER", "openai_compatible"), ("AI_API_KEY", "k")];
        assert!(Config::from_vars(vars(&only_key)).is_err());
        assert!(Config::from_vars(vars(&[("AI_PROVIDER", "gpt")])).is_err());
    }

    #[test]
    fn debug_never_shows_the_key() {
        let c = Config::from_vars(vars(&[
            ("AI_PROVIDER", "anthropic"),
            ("AI_API_KEY", "sk-secret-123"),
        ]))
        .unwrap()
        .unwrap();
        assert!(!format!("{c:?}").contains("sk-secret"));
    }
}
