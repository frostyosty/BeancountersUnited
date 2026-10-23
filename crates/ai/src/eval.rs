//! The bake-off (ADR 009): runs a suggester over the synthetic labelled set
//! (`fixtures/ai/labelled-lines.json`) and reports accuracy, the share it declined to pre-fill,
//! and the cost. `acctd ai-eval` runs it. We choose the cheapest model that's at least 90%
//! accurate on high-confidence answers.
//!
//! Requests are built exactly as Save tax builds them: through [`redact::request`], 50 lines at a
//! time, with no examples (as for a business's first upload). Costs are whole micro-dollars (US),
//! from prices per million tokens, so there's no floating point.

use std::collections::BTreeMap;

use acct_core::coding::Direction;
use acct_core::{GstCode, Money};
use serde::Deserialize;

use crate::redact::{self, Input, LineInput};
use crate::{Category, Confidence, Suggester, Usage};

/// Lines per request, as in Save tax.
pub const BATCH: usize = 50;

/// The labelled set's file.
#[derive(Debug, Clone, Deserialize)]
pub struct LabelledSet {
    pub categories: Vec<LabelledCategory>,
    pub lines: Vec<LabelledLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LabelledCategory {
    pub key: String,
    pub name: String,
    pub direction: Direction,
}

/// A bank line and its right answer. `amount` is signed cents: positive is money in.
#[derive(Debug, Clone, Deserialize)]
pub struct LabelledLine {
    pub description: String,
    pub amount: i64,
    pub category: String,
    pub gst: GstCode,
}

impl LabelledSet {
    pub fn parse(json: &str) -> Result<LabelledSet, String> {
        let set: LabelledSet =
            serde_json::from_str(json).map_err(|e| format!("the labelled set isn't valid: {e}"))?;
        for (i, l) in set.lines.iter().enumerate() {
            let direction = Direction::of(Money::from_cents(l.amount))
                .ok_or_else(|| format!("line {} has a nil amount", i + 1))?;
            if !set
                .categories
                .iter()
                .any(|c| c.key == l.category && c.direction == direction)
            {
                return Err(format!(
                    "line {} is labelled {:?}, which isn't a category for its direction",
                    i + 1,
                    l.category
                ));
            }
        }
        Ok(set)
    }
}

/// An answer that was wrong, for the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Miss {
    pub description: String,
    pub expected: String,
    pub got: String,
    pub confidence: Confidence,
}

/// What a run found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub model: String,
    pub lines: u64,
    /// Requests the suggester couldn't answer at all; their lines count as declined.
    pub failed_batches: u64,
    /// Answers naming a line we didn't send, a category we didn't offer, or a line twice.
    pub unusable: u64,
    /// Lines answered with low confidence, or not at all: no pre-fill.
    pub declined: u64,
    /// Lines that would be pre-filled (medium or high confidence).
    pub prefilled: u64,
    /// Pre-filled with the right category and GST code.
    pub prefilled_right: u64,
    pub high: u64,
    pub high_right: u64,
    /// High-confidence answers with the right category, whatever the GST code.
    pub high_category_right: u64,
    /// Wrong pre-fills, most confident first.
    pub misses: Vec<Miss>,
    pub usage: Usage,
}

/// Prices in micro-dollars (US) per million tokens, such as 100_000 for $0.10.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prices {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Prices {
    /// List prices for the models ADR 009 has checked (2026-10-23). Cache writes are 1.25 times
    /// the input price.
    pub fn known(model: &str) -> Option<Prices> {
        match model {
            "claude-haiku-5-5" => Some(Prices {
                input: 100_000,
                output: 500_000,
                cache_read: 10_000,
                cache_write: 125_000,
            }),
            "claude-sonnet-5-5" => Some(Prices {
                input: 2_000_000,
                output: 10_000_000,
                cache_read: 100_000,
                cache_write: 2_500_000,
            }),
            _ => None,
        }
    }

    /// Dollars as written, such as `0.10` or `2`, to micro-dollars. At most 6 decimal places.
    pub fn parse_usd(text: &str) -> Option<u64> {
        let text = text.trim().trim_start_matches('$');
        let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
        if whole.is_empty() && frac.is_empty()
            || frac.len() > 6
            || !whole
                .bytes()
                .chain(frac.bytes())
                .all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let whole: u64 = if whole.is_empty() {
            0
        } else {
            whole.parse().ok()?
        };
        let frac: u64 = format!("{frac:0<6}").parse().ok()?;
        whole.checked_mul(1_000_000)?.checked_add(frac)
    }

    /// What `usage` costs, in micro-dollars, rounded half up.
    pub fn cost(&self, usage: &Usage) -> u64 {
        let micro_mtok = u128::from(usage.input_tokens) * u128::from(self.input)
            + u128::from(usage.output_tokens) * u128::from(self.output)
            + u128::from(usage.cache_read_tokens) * u128::from(self.cache_read)
            + u128::from(usage.cache_write_tokens) * u128::from(self.cache_write);
        u64::try_from((micro_mtok + 500_000) / 1_000_000).unwrap_or(u64::MAX)
    }
}

/// Runs `suggester` over the set.
pub async fn run(suggester: &dyn Suggester, set: &LabelledSet) -> Report {
    let categories: Vec<Category> = set
        .categories
        .iter()
        .map(|c| Category {
            key: c.key.clone(),
            name: c.name.clone(),
            direction: c.direction,
        })
        .collect();
    let mut report = Report {
        model: suggester.model().to_owned(),
        lines: set.lines.len() as u64,
        ..Report::default()
    };
    let before = suggester.usage();
    for batch in set.lines.chunks(BATCH) {
        let inputs: Vec<LineInput<'_>> = batch
            .iter()
            .map(|l| LineInput {
                amount: Money::from_cents(l.amount),
                description: &l.description,
            })
            .collect();
        let request = redact::request(&Input {
            lines: &inputs,
            categories: &categories,
            examples: &[],
            activity: None,
            private_names: &[],
        });
        let answers = match suggester.suggest(request).await {
            Ok(a) => a,
            Err(_) => {
                report.failed_batches += 1;
                report.declined += batch.len() as u64;
                continue;
            }
        };
        // The first usable answer for each line counts.
        let mut answered: BTreeMap<usize, (String, GstCode, Confidence)> = BTreeMap::new();
        for a in answers {
            let index = (a.reference as usize).checked_sub(1);
            let line = index.and_then(|i| batch.get(i).map(|l| (i, l)));
            let usable = line.filter(|(i, l)| {
                let direction = Direction::of(Money::from_cents(l.amount));
                !answered.contains_key(i)
                    && categories
                        .iter()
                        .any(|c| c.key == a.category && Some(c.direction) == direction)
            });
            match usable {
                Some((i, _)) => {
                    answered.insert(i, (a.category, a.gst, a.confidence));
                }
                None => report.unusable += 1,
            }
        }
        for (i, line) in batch.iter().enumerate() {
            let Some((category, gst, confidence)) = answered.remove(&i) else {
                report.declined += 1;
                continue;
            };
            if confidence == Confidence::Low {
                report.declined += 1;
                continue;
            }
            let right_category = category == line.category;
            let right = right_category && gst == line.gst;
            report.prefilled += 1;
            report.prefilled_right += u64::from(right);
            if confidence == Confidence::High {
                report.high += 1;
                report.high_right += u64::from(right);
                report.high_category_right += u64::from(right_category);
            }
            if !right {
                report.misses.push(Miss {
                    description: line.description.clone(),
                    expected: format!("{} ({})", line.category, gst_text(line.gst)),
                    got: format!("{category} ({})", gst_text(gst)),
                    confidence,
                });
            }
        }
    }
    let after = suggester.usage();
    report.usage = Usage {
        requests: after.requests - before.requests,
        input_tokens: after.input_tokens - before.input_tokens,
        output_tokens: after.output_tokens - before.output_tokens,
        cache_read_tokens: after.cache_read_tokens - before.cache_read_tokens,
        cache_write_tokens: after.cache_write_tokens - before.cache_write_tokens,
    };
    report.misses.sort_by(|a, b| {
        b.confidence
            .cmp(&a.confidence)
            .then(a.description.cmp(&b.description))
    });
    report
}

fn gst_text(gst: GstCode) -> &'static str {
    match gst {
        GstCode::Standard => "standard",
        GstCode::Zero => "zero",
        GstCode::Exempt => "exempt",
        GstCode::None => "none",
    }
}

/// `part` of `whole` as a percentage with one decimal place, such as `93.4%`.
fn percent(part: u64, whole: u64) -> String {
    if whole == 0 {
        return "n/a".to_owned();
    }
    let tenths = (part * 1000 + whole / 2) / whole;
    format!("{}.{}%", tenths / 10, tenths % 10)
}

/// Micro-dollars as dollars, such as `$0.0213`.
fn usd(micro: u64) -> String {
    format!(
        "${}.{:04}",
        micro / 1_000_000,
        (micro % 1_000_000 + 50) / 100
    )
}

impl Report {
    /// The ADR's bar: at least 90% of high-confidence answers right (category and GST code).
    pub fn meets_the_bar(&self) -> bool {
        self.high > 0 && self.high_right * 10 >= self.high * 9
    }

    /// The report as `acctd ai-eval` prints it.
    pub fn render(&self, prices: Option<Prices>) -> String {
        let mut out = String::new();
        let mut line = |s: String| {
            out.push_str(&s);
            out.push('\n');
        };
        line(format!("Model: {}", self.model));
        line(format!(
            "Lines: {} in {} requests ({} failed)",
            self.lines, self.usage.requests, self.failed_batches
        ));
        line(format!(
            "High confidence: {} lines, {} right ({}); category alone right {}",
            self.high,
            self.high_right,
            percent(self.high_right, self.high),
            percent(self.high_category_right, self.high)
        ));
        line(format!(
            "Pre-filled (medium or high): {} lines, {} right ({})",
            self.prefilled,
            self.prefilled_right,
            percent(self.prefilled_right, self.prefilled)
        ));
        line(format!(
            "Declined to pre-fill: {} lines ({})",
            self.declined,
            percent(self.declined, self.lines)
        ));
        line(format!("Unusable answers dropped: {}", self.unusable));
        line(format!(
            "Tokens: {} input, {} output, {} cache read, {} cache write",
            self.usage.input_tokens,
            self.usage.output_tokens,
            self.usage.cache_read_tokens,
            self.usage.cache_write_tokens
        ));
        match prices {
            Some(p) if self.lines > 0 => {
                let cost = p.cost(&self.usage);
                let per_1000 =
                    (u128::from(cost) * 1000 + u128::from(self.lines) / 2) / u128::from(self.lines);
                line(format!(
                    "Cost: {} for this run, about {} per 1,000 lines",
                    usd(cost),
                    usd(u64::try_from(per_1000).unwrap_or(u64::MAX))
                ));
            }
            _ => line(
                "Cost: unknown prices for this model; set AI_PRICE_INPUT and AI_PRICE_OUTPUT \
                 (USD per million tokens)"
                    .to_owned(),
            ),
        }
        line(format!(
            "Meets the 90% bar on high-confidence answers: {}",
            if self.meets_the_bar() { "yes" } else { "no" }
        ));
        if !self.misses.is_empty() {
            line("Wrong pre-fills (up to 15):".to_owned());
            for m in self.misses.iter().take(15) {
                line(format!(
                    "  [{:?}] {}: expected {}, got {}",
                    m.confidence, m.description, m.expected, m.got
                ));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FakeAnswer, FakeSuggester};

    const SET: &str = include_str!("../../../fixtures/ai/labelled-lines.json");

    #[test]
    fn the_labelled_set_is_valid_and_about_300_lines() {
        let set = LabelledSet::parse(SET).unwrap();
        assert!((300..=400).contains(&set.lines.len()));
        // Every category a line can be labelled with is offered for its direction.
        assert!(set.categories.iter().any(|c| c.key == "personal"));
    }

    #[test]
    fn a_label_that_isnt_offered_is_refused() {
        let bad = r#"{"categories":[{"key":"255","name":"Power","direction":"out"}],
            "lines":[{"description":"X","amount":500,"category":"255","gst":"standard"}]}"#;
        assert!(LabelledSet::parse(bad).is_err());
    }

    #[test]
    fn prices_are_whole_micro_dollars() {
        assert_eq!(Prices::parse_usd("0.10"), Some(100_000));
        assert_eq!(Prices::parse_usd("$2"), Some(2_000_000));
        assert_eq!(Prices::parse_usd(".5"), Some(500_000));
        assert_eq!(Prices::parse_usd("1.0000001"), None);
        assert_eq!(Prices::parse_usd("abc"), None);
        let haiku = Prices::known("claude-haiku-5-5").unwrap();
        // ADR 009's estimate per 1,000 lines: 30k in, 25k out, 40k cache reads = about $0.0158.
        let usage = Usage {
            requests: 20,
            input_tokens: 30_000,
            output_tokens: 25_000,
            cache_read_tokens: 40_000,
            cache_write_tokens: 0,
        };
        assert_eq!(haiku.cost(&usage), 15_900);
        assert_eq!(usd(15_900), "$0.0159");
        assert_eq!(percent(9, 10), "90.0%");
        assert_eq!(percent(2, 3), "66.7%");
    }

    #[tokio::test]
    async fn a_run_counts_right_wrong_and_declined() {
        let set = LabelledSet::parse(SET).unwrap();
        let fake = FakeSuggester::new(
            "fake",
            vec![
                FakeAnswer::new("GRIDLINE POWER", "255", GstCode::Standard, Confidence::High),
                // Wrong on purpose: phone lines aren't power.
                FakeAnswer::new("TELEWAVE", "255", GstCode::Standard, Confidence::High),
                FakeAnswer::new(
                    "PIKORUA CAFE",
                    "personal",
                    GstCode::None,
                    Confidence::Medium,
                ),
                FakeAnswer::new("FEE", "205", GstCode::Exempt, Confidence::Low),
            ],
        );
        let report = run(&fake, &set).await;
        let count = |text: &str| {
            set.lines
                .iter()
                .filter(|l| l.description.contains(text))
                .count() as u64
        };
        let (power, phone, cafe) = (
            count("GRIDLINE POWER"),
            count("TELEWAVE"),
            count("PIKORUA CAFE"),
        );
        assert!(power > 0 && phone > 0 && cafe > 0);
        assert_eq!(report.lines, set.lines.len() as u64);
        assert_eq!(report.high, power + phone);
        assert_eq!(report.high_right, power);
        assert_eq!(report.prefilled, power + phone + cafe);
        assert_eq!(report.prefilled_right, power + cafe);
        assert_eq!(report.declined, report.lines - report.prefilled);
        assert_eq!(report.misses.len() as u64, phone);
        assert_eq!(fake.seen().len(), set.lines.len().div_ceil(BATCH));
        assert!(!report.meets_the_bar() || power * 10 >= (power + phone) * 9);
        let text = report.render(None);
        assert!(text.contains("Meets the 90% bar"));
        assert!(text.contains("TELEWAVE"));
    }

    #[tokio::test]
    async fn a_failing_service_declines_everything() {
        let set = LabelledSet::parse(SET).unwrap();
        let report = run(&FakeSuggester::failing("fake"), &set).await;
        assert_eq!(report.declined, report.lines);
        assert_eq!(
            report.failed_batches as usize,
            set.lines.len().div_ceil(BATCH)
        );
        assert!(!report.meets_the_bar());
    }
}
