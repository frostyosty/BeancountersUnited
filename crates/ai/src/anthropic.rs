//! Anthropic's native Messages API: structured outputs, and prompt caching of the instructions
//! and the business's categories.

use std::sync::Mutex;

use serde_json::{Value, json};

use crate::prompt::{INSTRUCTIONS, answer_schema, batch, business_context, parse_answer};
use crate::{
    AiError, RawSuggestion, SuggestFuture, SuggestRequest, Suggester, Usage, count, post_json,
};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2026-10-21";
/// Room for about 50 short answers.
const MAX_TOKENS: u32 = 4096;

pub struct Client {
    http: reqwest::Client,
    url: String,
    model: String,
    api_key: String,
    usage: Mutex<Usage>,
}

impl Client {
    pub fn new(http: reqwest::Client, base_url: &str, model: &str, api_key: &str) -> Client {
        Client {
            http,
            url: format!("{}/v1/messages", base_url.trim_end_matches('/')),
            model: model.to_owned(),
            api_key: api_key.to_owned(),
            usage: Mutex::new(Usage::default()),
        }
    }
}

/// The request body.
pub(crate) fn body(model: &str, request: &SuggestRequest) -> Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [
            { "type": "text", "text": INSTRUCTIONS },
            {
                "type": "text",
                "text": business_context(request),
                "cache_control": { "type": "ephemeral" }
            }
        ],
        "messages": [{ "role": "user", "content": batch(request) }],
        "output_config": {
            "effort": "low",
            "format": { "type": "json_schema", "schema": answer_schema() }
        }
    })
}

/// The tokens a Messages API response says it used.
pub(crate) fn usage_of(response: &Value) -> Usage {
    Usage {
        requests: 1,
        input_tokens: count(response, &["usage", "input_tokens"]),
        output_tokens: count(response, &["usage", "output_tokens"]),
        cache_read_tokens: count(response, &["usage", "cache_read_input_tokens"]),
        cache_write_tokens: count(response, &["usage", "cache_creation_input_tokens"]),
    }
}

/// Reads a Messages API response.
pub(crate) fn read(response: &Value) -> Result<Vec<RawSuggestion>, AiError> {
    match response.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => return Err(AiError::Refused),
        Some("max_tokens") => return Err(AiError::BadResponse("the answer was cut off")),
        _ => {}
    }
    let text = response
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks
                .iter()
                .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(Value::as_str)
        .ok_or(AiError::BadResponse("the answer had no text"))?;
    parse_answer(text)
}

impl Suggester for Client {
    fn provider(&self) -> &str {
        "Anthropic"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn suggest(&self, request: SuggestRequest) -> SuggestFuture<'_> {
        Box::pin(async move {
            let body = body(&self.model, &request);
            let call = self
                .http
                .post(&self.url)
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", API_VERSION);
            let response = post_json(call, &body).await?;
            self.usage
                .lock()
                .expect("not poisoned")
                .add(usage_of(&response));
            read(&response)
        })
    }

    fn usage(&self) -> Usage {
        *self.usage.lock().expect("not poisoned")
    }
}
