//! A suggester with canned answers keyed on description words, for tests and `acct-dev`. It also
//! keeps every request it was given, so tests can check exactly what would have left the server.

use std::sync::Mutex;

use acct_core::GstCode;

use crate::{AiError, Confidence, RawSuggestion, SuggestFuture, SuggestRequest, Suggester};

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
    seen: Mutex<Vec<SuggestRequest>>,
}

impl FakeSuggester {
    pub fn new(model: &str, answers: Vec<FakeAnswer>) -> Self {
        FakeSuggester {
            model: model.to_owned(),
            answers,
            fail: false,
            seen: Mutex::new(Vec::new()),
        }
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
        let result = if self.fail {
            Err(AiError::Network("the fake is set to fail".to_owned()))
        } else {
            Ok(self.answer(&request))
        };
        self.seen.lock().expect("not poisoned").push(request);
        Box::pin(async move { result })
    }
}
