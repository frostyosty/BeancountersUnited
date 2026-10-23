//! The prompt and the answer's shape, shared by both adapters. Everything sent is built from a
//! [`SuggestRequest`], so it holds only what redaction let through.
//!
//! The request is split so the stable part can be cached: the instructions, then the business's
//! categories and activity (the same for every batch of a business), then the batch itself.

use acct_core::GstCode;
use acct_core::coding::Direction;
use serde_json::{Value, json};

use crate::{AiError, Confidence, RawSuggestion, SuggestRequest};

/// Our own instructions. No business's data goes here.
pub(crate) const INSTRUCTIONS: &str = "\
You help New Zealand sole traders sort their bank transactions for GST and income tax.

For each transaction, choose the category it most likely belongs to, from the categories given for \
its direction (money in or money out), and the GST code that usually applies:
- standard: GST at the standard rate is included, as for most purchases and sales from \
GST-registered businesses in New Zealand.
- zero: zero-rated, such as exports.
- exempt: exempt supplies, such as bank fees, interest and residential rent.
- none: outside GST, such as wages, drawings, money that isn't income, or overseas services \
with no NZ GST.

Descriptions are bank statement text, shortened, with private details replaced by placeholders \
such as [acct], [ird], [phone], [email], [url] and #. Amounts are whole dollars.

Say how sure you are: high when the merchant or wording makes the category clear, medium when it \
is likely, low when you are guessing. Use low rather than guess. Answer every transaction once, \
by its ref, and only with category keys from the list.";

fn direction(d: Direction) -> &'static str {
    match d {
        Direction::In => "in",
        Direction::Out => "out",
    }
}

fn gst(code: GstCode) -> &'static str {
    match code {
        GstCode::Standard => "standard",
        GstCode::Zero => "zero",
        GstCode::Exempt => "exempt",
        GstCode::None => "none",
    }
}

/// The business's part: its categories and activity. JSON, keys in a fixed order, so it caches.
pub(crate) fn business_context(request: &SuggestRequest) -> String {
    let categories: Vec<Value> = request
        .categories()
        .iter()
        .map(|c| json!({ "key": c.key, "name": c.name, "direction": direction(c.direction) }))
        .collect();
    let mut context = json!({ "categories": categories });
    if let Some(activity) = request.activity() {
        context["business_activity"] = json!(activity);
    }
    context.to_string()
}

/// The batch: the examples and the lines to answer.
pub(crate) fn batch(request: &SuggestRequest) -> String {
    let examples: Vec<Value> = request
        .examples()
        .iter()
        .map(|e| {
            json!({
                "direction": direction(e.direction()),
                "amount": e.dollars(),
                "description": e.description(),
                "category": e.category(),
                "gst": gst(e.gst()),
            })
        })
        .collect();
    let lines: Vec<Value> = request
        .lines()
        .iter()
        .map(|l| {
            json!({
                "ref": l.reference(),
                "direction": direction(l.direction()),
                "amount": l.dollars(),
                "description": l.description(),
            })
        })
        .collect();
    json!({ "already_sorted_examples": examples, "transactions": lines }).to_string()
}

/// The JSON schema the answer must follow.
pub(crate) fn answer_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": { "type": "integer" },
                        "category": { "type": "string" },
                        "gst": { "type": "string", "enum": ["standard", "zero", "exempt", "none"] },
                        "confidence": { "type": "string", "enum": ["low", "medium", "high"] }
                    },
                    "required": ["ref", "category", "gst", "confidence"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["suggestions"],
        "additionalProperties": false
    })
}

/// Reads the model's JSON answer. An item that doesn't fit the shape is dropped; the server
/// validates the rest (that the reference and category were offered, and so on).
pub(crate) fn parse_answer(text: &str) -> Result<Vec<RawSuggestion>, AiError> {
    let value: Value = serde_json::from_str(text.trim())
        .map_err(|_| AiError::BadResponse("the answer wasn't JSON"))?;
    let items = value
        .get("suggestions")
        .and_then(Value::as_array)
        .ok_or(AiError::BadResponse("the answer had no suggestions list"))?;
    Ok(items.iter().filter_map(item).collect())
}

fn item(v: &Value) -> Option<RawSuggestion> {
    let reference = u32::try_from(v.get("ref")?.as_u64()?).ok()?;
    let category = v.get("category")?.as_str()?.trim().to_owned();
    let gst = match v.get("gst")?.as_str()? {
        "standard" => GstCode::Standard,
        "zero" => GstCode::Zero,
        "exempt" => GstCode::Exempt,
        "none" => GstCode::None,
        _ => return None,
    };
    let confidence = match v.get("confidence")?.as_str()? {
        "low" => Confidence::Low,
        "medium" => Confidence::Medium,
        "high" => Confidence::High,
        _ => return None,
    };
    Some(RawSuggestion {
        reference,
        category,
        gst,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_good_items_and_drops_bad_ones() {
        let text = r#"{"suggestions":[
            {"ref":1,"category":"610","gst":"standard","confidence":"high"},
            {"ref":2,"category":"personal","gst":"maybe","confidence":"high"},
            {"ref":-3,"category":"610","gst":"none","confidence":"low"},
            {"ref":4,"category":"400","gst":"zero","confidence":"medium"}
        ]}"#;
        let got = parse_answer(text).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].reference, 1);
        assert_eq!(got[1].gst, GstCode::Zero);
        assert_eq!(got[1].confidence, Confidence::Medium);
    }

    #[test]
    fn rejects_text_that_isnt_the_shape() {
        assert!(parse_answer("Sure! Here you go").is_err());
        assert!(parse_answer(r#"{"answers":[]}"#).is_err());
    }
}
