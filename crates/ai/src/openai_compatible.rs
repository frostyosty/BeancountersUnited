//! The Chat Completions shape with a JSON-schema response format. OpenAI, Gemini, Mistral,
//! OpenRouter, Anthropic's compatibility endpoint and a self-hosted Ollama all accept it.

use std::sync::Mutex;

use serde_json::{Value, json};

use crate::prompt::{INSTRUCTIONS, answer_schema, batch, business_context, parse_answer};
use crate::{
    AiError, RawSuggestion, SuggestFuture, SuggestRequest, Suggester, Usage, count, post_json,
};

pub struct Client {
    provider: String,
    http: reqwest::Client,
    url: String,
    model: String,
    api_key: String,
    usage: Mutex<Usage>,
}

impl Client {
    /// `base_url` is the provider's API root, such as `https://api.openai.com/v1`.
    /// `provider` is the name Save tax shows, such as `OpenAI`.
    pub fn new(
        provider: &str,
        http: reqwest::Client,
        base_url: &str,
        model: &str,
        api_key: &str,
    ) -> Client {
        Client {
            provider: provider.to_owned(),
            http,
            url: format!("{}/chat/completions", base_url.trim_end_matches('/')),
            model: model.to_owned(),
            api_key: api_key.to_owned(),
            usage: Mutex::new(Usage::default()),
        }
    }
}

/// The request body. The instructions and categories come first, so providers that cache
/// prefixes automatically can.
pub(crate) fn body(model: &str, request: &SuggestRequest) -> Value {
    json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": format!("{INSTRUCTIONS}\n\n{}", business_context(request))
            },
            { "role": "user", "content": batch(request) }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "bank_line_categories",
                "strict": true,
                "schema": answer_schema()
            }
        }
    })
}

/// The tokens a Chat Completions response says it used. `prompt_tokens` includes cached ones.
pub(crate) fn usage_of(response: &Value) -> Usage {
    let prompt = count(response, &["usage", "prompt_tokens"]);
    let cached = count(
        response,
        &["usage", "prompt_tokens_details", "cached_tokens"],
    );
    Usage {
        requests: 1,
        input_tokens: prompt.saturating_sub(cached),
        output_tokens: count(response, &["usage", "completion_tokens"]),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
    }
}

/// Reads a Chat Completions response.
pub(crate) fn read(response: &Value) -> Result<Vec<RawSuggestion>, AiError> {
    let choice = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .ok_or(AiError::BadResponse("the answer had no choices"))?;
    match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => return Err(AiError::BadResponse("the answer was cut off")),
        Some("content_filter") => return Err(AiError::Refused),
        _ => {}
    }
    let message = choice
        .get("message")
        .ok_or(AiError::BadResponse("the answer had no message"))?;
    if message.get("refusal").is_some_and(|r| !r.is_null()) {
        return Err(AiError::Refused);
    }
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .ok_or(AiError::BadResponse("the answer had no text"))?;
    parse_answer(text)
}

impl Suggester for Client {
    fn provider(&self) -> &str {
        &self.provider
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn suggest(&self, request: SuggestRequest) -> SuggestFuture<'_> {
        Box::pin(async move {
            let body = body(&self.model, &request);
            let call = self.http.post(&self.url).bearer_auth(&self.api_key);
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
