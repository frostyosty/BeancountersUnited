//! A suggester with canned answers keyed on description words, for tests and `acct-dev`. It also
//! keeps every request it was given, so tests can check exactly what would have left the server.

use std::sync::Mutex;

use acct_core::GstCode;

use crate::{
    AiError, Call, Confidence, ExplainFuture, ExplainRequest, RawSuggestion, SuggestFuture,
    SuggestRequest, Suggester, Usage,
};

/// The tokens each successful call of a [`FakeSuggester`] reports, unless
/// [`FakeSuggester::with_usage`] says otherwise. A failing one reports none, as a network error
/// would.
pub const FAKE_CALL_USAGE: Usage = Usage {
    requests: 1,
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
};

/// "A line whose description contains `contains` is `category`." `category` is a category key,
/// or else a word in a category's name, such as `freight`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeAnswer {
    pub contains: String,
    pub category: String,
    pub gst: GstCode,
    pub confidence: Confidence,
}

impl FakeAnswer {
    pub fn new(contains: &str, category: &str, gst: GstCode, confidence: Confidence) -> Self {
        FakeAnswer {
            contains: contains.to_uppercase(),
            category: category.to_owned(),
            gst,
            confidence,
        }
    }
}

pub struct FakeSuggester {
    model: String,
    answers: Vec<FakeAnswer>,
    fail: bool,
    usage: Usage,
    seen: Mutex<Vec<SuggestRequest>>,
    explained: Mutex<Vec<ExplainRequest>>,
}

impl FakeSuggester {
    pub fn new(model: &str, answers: Vec<FakeAnswer>) -> Self {
        FakeSuggester {
            model: model.to_owned(),
            answers,
            fail: false,
            usage: FAKE_CALL_USAGE,
            seen: Mutex::new(Vec::new()),
            explained: Mutex::new(Vec::new()),
        }
    }

    /// The tokens each successful call reports, so tests can check what an ask cost.
    #[must_use]
    pub fn with_usage(mut self, usage: Usage) -> Self {
        self.usage = usage;
        self
    }

    /// One that always fails, as an unreachable provider would.
    pub fn failing(model: &str) -> Self {
        FakeSuggester {
            fail: true,
            ..FakeSuggester::new(model, Vec::new())
        }
    }

    /// Answers for the kinds of merchant in the synthetic fixtures, by category name.
    pub fn with_defaults(model: &str) -> Self {
        use Confidence::{High, Low, Medium};
        use GstCode::{Exempt, None, Standard};
        let a = FakeAnswer::new;
        FakeSuggester::new(
            model,
            vec![
                a("POWER", "power", Standard, High),
                a("COURIER", "freight", Standard, High),
                a("MOBILE", "phone", Standard, High),
                a("INSURANCE", "insurance", Standard, High),
                a("HOSTING", "software", Standard, High),
                a("STATIONER", "stationery", Standard, High),
                a("GAS & GO", "vehicle", Standard, Medium),
                a("SUPPLIES", "purchases", Standard, Medium),
                a("HARDWARE", "small tools", Standard, Medium),
                a("STALL FEE", "advertising", Standard, Low),
                a("GROCER", "personal", None, High),
                a("CAFE", "personal", None, Medium),
                a("ATM", "personal", None, Medium),
                a("INTEREST", "interest", Exempt, High),
                a("GIFTS", "sales", Standard, High),
                a("BOUTIQUE", "sales", Standard, High),
                a("PAYOUT", "sales", Standard, Medium),
            ],
        )
    }

    /// Every request it has been given, oldest first.
    pub fn seen(&self) -> Vec<SuggestRequest> {
        self.seen.lock().expect("not poisoned").clone()
    }

    /// Every explanation request it has been given, oldest first.
    pub fn explained(&self) -> Vec<ExplainRequest> {
        self.explained.lock().expect("not poisoned").clone()
    }

    fn answer(&self, request: &SuggestRequest) -> Vec<RawSuggestion> {
        request
            .lines()
            .iter()
            .filter_map(|line| {
                let description = line.description().to_uppercase();
                let answer = self
                    .answers
                    .iter()
                    .find(|a| description.contains(&a.contains))?;
                let wanted = answer.category.to_lowercase();
                let category = request
                    .categories()
                    .iter()
                    .filter(|c| c.direction == line.direction())
                    .find(|c| {
                        c.key == answer.category || c.name.to_lowercase().contains(&wanted)
                    })?;
                Some(RawSuggestion {
                    reference: line.reference(),
                    category: category.key.clone(),
                    gst: answer.gst,
                    confidence: answer.confidence,
                })
            })
            .collect()
    }
}

impl Suggester for FakeSuggester {
    fn provider(&self) -> &str {
        "a test service"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn suggest(&self, request: SuggestRequest) -> SuggestFuture<'_> {
        let call = if self.fail {
            Call::failed(AiError::Network("the fake is set to fail".to_owned()))
        } else {
            Call::new(Ok(self.answer(&request)), self.usage)
        };
        self.seen.lock().expect("not poisoned").push(request);
        Box::pin(async move { call })
    }

    fn explain(&self, request: ExplainRequest) -> ExplainFuture<'_> {
        let call = if self.fail {
            Call::failed(AiError::Network("the fake is set to fail".to_owned()))
        } else {
            Call::new(
                Ok(format!(
                    "This is a test explanation. It was given: {}",
                    request.facts().replace('\n', " / ")
                )),
                self.usage,
            )
        };
        self.explained.lock().expect("not poisoned").push(request);
        Box::pin(async move { call })
    }
}
