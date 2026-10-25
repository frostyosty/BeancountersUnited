//! Accounting policies and notes, filled in from the practice paragraph library.
//!
//! A [`Paragraph`] is a titled piece of our own wording with fields such as `{business_name}`.
//! Each client-year keeps its own copies (the server stores them); [`build_notes`] fills them in
//! with the year's [`NoteFields`] and lays them out for the ReportDoc, after the statements:
//! - note 1, "Statement of accounting policies", holds every [`Placement::Policy`] paragraph under
//!   its own sub-heading, in the order the year picked them;
//! - every [`Placement::Note`] paragraph follows as its own numbered note, in picked order.
//!
//! The layout and wording decisions are in `docs/domain.md`, "Accounting policies and notes".
//!
//! Field syntax: `{name}` is a field; `{{` and `}}` are literal braces. A field this module
//! doesn't know, a field whose value is empty, or a stray brace is an error, never left in the
//! text. The output is plain text, so the same inputs always give byte-identical notes.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::depreciation::{Method, SlBasis};
use crate::template::LineKey;

/// The heading over the notes, as renderers show it.
pub const NOTES_TITLE: &str = "Notes to the financial statements";
/// The key and title of note 1, which holds the policies.
pub const POLICIES_KEY: &str = "accounting_policies";
pub const POLICIES_TITLE: &str = "Statement of accounting policies";

/// Where a paragraph goes in the notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Placement {
    /// A sub-heading inside note 1, the statement of accounting policies.
    Policy,
    /// A numbered note of its own.
    Note,
}

/// A paragraph: from the practice library, or a client-year's copy of one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Paragraph {
    /// A stable key such as `basis_of_preparation`, unique in its library.
    pub key: LineKey,
    pub placement: Placement,
    pub title: String,
    /// The wording, with `{field}`s. A blank line starts a new paragraph of text.
    pub body: String,
}

/// The fields a paragraph may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Field {
    /// The client's name.
    BusinessName,
    /// The year's first day, such as "1 April 2025".
    PeriodStart,
    /// The year's last day, such as "31 March 2026".
    BalanceDate,
    /// One line per asset class held in the year, such as "Vehicles: 30% diminishing value".
    DepreciationMethods,
}

impl Field {
    pub const ALL: [Field; 4] = [
        Field::BusinessName,
        Field::PeriodStart,
        Field::BalanceDate,
        Field::DepreciationMethods,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            Field::BusinessName => "business_name",
            Field::PeriodStart => "period_start",
            Field::BalanceDate => "balance_date",
            Field::DepreciationMethods => "depreciation_methods",
        }
    }

    pub fn from_name(name: &str) -> Option<Field> {
        Field::ALL.into_iter().find(|f| f.name() == name)
    }
}

/// A client-year's values for the fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFields {
    pub business_name: String,
    pub period_start: NaiveDate,
    pub balance_date: NaiveDate,
    /// From [`depreciation_methods`].
    pub depreciation_methods: Vec<String>,
}

impl NoteFields {
    /// The text a field fills in. Empty means there's nothing to say, which [`fill`] rejects.
    pub fn value(&self, field: Field) -> String {
        match field {
            // A name is one line: any run of whitespace becomes one space.
            Field::BusinessName => self
                .business_name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            Field::PeriodStart => long_date(self.period_start),
            Field::BalanceDate => long_date(self.balance_date),
            Field::DepreciationMethods => self.depreciation_methods.join("\n"),
        }
    }
}

/// A date as notes write it: "31 March 2026".
pub fn long_date(date: NaiveDate) -> String {
    date.format("%-d %B %Y").to_string()
}

/// A problem with a paragraph. `paragraph` is its key.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum NoteError {
    #[error("“{paragraph}” uses {{{field}}}, which isn't a field notes can fill in")]
    UnknownField { paragraph: LineKey, field: String },
    #[error("“{paragraph}” uses {{{field}}}, but this year has nothing to fill it with")]
    EmptyField { paragraph: LineKey, field: String },
    /// A `{` or `}` that isn't part of a field or a doubled brace. `at` is its byte offset.
    #[error(
        "“{paragraph}” has a stray brace at character {at}; write {{{{ or }}}} for a literal one"
    )]
    StrayBrace { paragraph: LineKey, at: usize },
    #[error("“{paragraph}” needs a title")]
    EmptyTitle { paragraph: LineKey },
    #[error("“{paragraph}” has no wording")]
    EmptyBody { paragraph: LineKey },
}

/// One piece of a paragraph's body.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Piece<'a> {
    Text(&'a str),
    Brace(char),
    Field(&'a str),
}

/// Splits a body into text and fields. A field name is lowercase letters, digits and `_`.
fn parse<'a>(key: &LineKey, body: &'a str) -> Result<Vec<Piece<'a>>, NoteError> {
    let stray = |at| NoteError::StrayBrace {
        paragraph: key.clone(),
        at,
    };
    let bytes = body.as_bytes();
    let mut pieces = Vec::new();
    let mut text_from = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b @ (b'{' | b'}') if bytes.get(i + 1) == Some(&b) => {
                pieces.push(Piece::Text(&body[text_from..i]));
                pieces.push(Piece::Brace(b as char));
                i += 2;
                text_from = i;
            }
            b'{' => {
                let close = body[i + 1..].find('}').map(|n| i + 1 + n).ok_or(stray(i))?;
                let name = &body[i + 1..close];
                let ok = !name.is_empty()
                    && name
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_');
                if !ok {
                    return Err(stray(i));
                }
                pieces.push(Piece::Text(&body[text_from..i]));
                pieces.push(Piece::Field(name));
                i = close + 1;
                text_from = i;
            }
            b'}' => return Err(stray(i)),
            _ => i += 1,
        }
    }
    pieces.push(Piece::Text(&body[text_from..]));
    pieces.retain(|p| *p != Piece::Text(""));
    Ok(pieces)
}

/// The body's paragraphs of text, before filling: split on blank lines, each line's trailing
/// whitespace dropped, and Windows line endings made plain.
fn blocks(body: &str) -> Vec<String> {
    let body = body.replace("\r\n", "\n");
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in body.split('\n') {
        let line = line.trim_end();
        if line.trim().is_empty() {
            if !current.is_empty() {
                out.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        out.push(current.join("\n"));
    }
    out
}

/// Checks a paragraph before it's stored: a title, some wording, braces that pair up, and only
/// fields notes know. Every problem is reported, not just the first.
pub fn check(p: &Paragraph) -> Result<(), Vec<NoteError>> {
    let mut errors = Vec::new();
    if p.title.trim().is_empty() {
        errors.push(NoteError::EmptyTitle {
            paragraph: p.key.clone(),
        });
    }
    if blocks(&p.body).is_empty() {
        errors.push(NoteError::EmptyBody {
            paragraph: p.key.clone(),
        });
    }
    match parse(&p.key, &p.body) {
        Err(e) => errors.push(e),
        Ok(pieces) => {
            for piece in pieces {
                if let Piece::Field(name) = piece
                    && Field::from_name(name).is_none()
                {
                    let e = NoteError::UnknownField {
                        paragraph: p.key.clone(),
                        field: name.to_owned(),
                    };
                    if !errors.contains(&e) {
                        errors.push(e);
                    }
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Fills in a paragraph's fields. Returns its paragraphs of text, in order. Fails on an unknown
/// field, a field with no value, or a stray brace.
pub fn fill(p: &Paragraph, fields: &NoteFields) -> Result<Vec<String>, Vec<NoteError>> {
    check(p)?;
    let mut errors = Vec::new();
    let mut out = Vec::new();
    for block in blocks(&p.body) {
        let pieces = parse(&p.key, &block).map_err(|e| vec![e])?;
        let mut text = String::new();
        for piece in pieces {
            match piece {
                Piece::Text(t) => text.push_str(t),
                Piece::Brace(c) => text.push(c),
                Piece::Field(name) => {
                    // `check` has already rejected unknown names.
                    let field = Field::from_name(name).expect("checked");
                    let value = fields.value(field);
                    if value.trim().is_empty() {
                        let e = NoteError::EmptyField {
                            paragraph: p.key.clone(),
                            field: name.to_owned(),
                        };
                        if !errors.contains(&e) {
                            errors.push(e);
                        }
                    }
                    text.push_str(&value);
                }
            }
        }
        out.push(text);
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

/// One numbered note in the ReportDoc.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportNote {
    pub number: u32,
    /// `accounting_policies` for note 1; otherwise the paragraph's key.
    pub key: LineKey,
    pub title: String,
    pub sections: Vec<NoteSection>,
}

/// A part of a note. The policies note has one per policy, each with its title as a sub-heading;
/// any other note has one, untitled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NoteSection {
    pub key: LineKey,
    pub title: Option<String>,
    /// Paragraphs of plain text. A line break inside one is `\n`.
    pub text: Vec<String>,
}

/// Builds the notes from a year's paragraphs, in the order it picked them. Every problem in every
/// paragraph is reported.
pub fn build_notes(
    paragraphs: &[Paragraph],
    fields: &NoteFields,
) -> Result<Vec<ReportNote>, Vec<NoteError>> {
    let mut errors = Vec::new();
    let mut policies = Vec::new();
    let mut notes = Vec::new();
    for p in paragraphs {
        match fill(p, fields) {
            Err(es) => errors.extend(es),
            Ok(text) => match p.placement {
                Placement::Policy => policies.push(NoteSection {
                    key: p.key.clone(),
                    title: Some(p.title.trim().to_owned()),
                    text,
                }),
                Placement::Note => notes.push((p, text)),
            },
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut out = Vec::new();
    if !policies.is_empty() {
        out.push(ReportNote {
            number: 1,
            key: POLICIES_KEY.parse().expect("a valid key"),
            title: POLICIES_TITLE.to_owned(),
            sections: policies,
        });
    }
    for (p, text) in notes {
        out.push(ReportNote {
            number: u32::try_from(out.len())
                .unwrap_or(u32::MAX)
                .saturating_add(1),
            key: p.key.clone(),
            title: p.title.trim().to_owned(),
            sections: vec![NoteSection {
                key: p.key.clone(),
                title: None,
                text,
            }],
        });
    }
    Ok(out)
}

/// The `{depreciation_methods}` lines: one per asset class, in the order classes first appear,
/// each listing its distinct methods, such as "Vehicles: 30% diminishing value". `held` is each
/// asset held in the year, as (its class's name, its method).
pub fn depreciation_methods(held: &[(String, Method)]) -> Vec<String> {
    let mut classes: Vec<(&str, Vec<String>)> = Vec::new();
    for (class, method) in held {
        let text = method_text(*method);
        match classes.iter_mut().find(|(c, _)| c == class) {
            Some((_, methods)) => {
                if !methods.contains(&text) {
                    methods.push(text);
                }
            }
            None => classes.push((class, vec![text])),
        }
    }
    classes
        .into_iter()
        .map(|(class, mut methods)| {
            methods.sort();
            format!("{class}: {}", methods.join("; "))
        })
        .collect()
}

fn method_text(method: Method) -> String {
    match method {
        Method::Dv { rate_bp } => format!("{} diminishing value", percent(rate_bp)),
        Method::Sl {
            basis: SlBasis::Rate { rate_bp },
        } => format!("{} straight line", percent(rate_bp)),
        Method::Sl {
            basis: SlBasis::Life { months },
        } => {
            if months % 12 == 0 {
                let years = months / 12;
                format!(
                    "straight line over {years} {}",
                    if years == 1 { "year" } else { "years" }
                )
            } else {
                format!("straight line over {months} months")
            }
        }
        Method::None => "not depreciated".to_owned(),
    }
}

/// Basis points as a percentage with no trailing zeros: 2500 → "25%", 1250 → "12.5%".
fn percent(rate_bp: u32) -> String {
    let (whole, frac) = (rate_bp / 100, rate_bp % 100);
    if frac == 0 {
        format!("{whole}%")
    } else if frac % 10 == 0 {
        format!("{whole}.{}%", frac / 10)
    } else {
        format!("{whole}.{frac:02}%")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> LineKey {
        s.parse().unwrap()
    }

    fn para(k: &str, placement: Placement, title: &str, body: &str) -> Paragraph {
        Paragraph {
            key: key(k),
            placement,
            title: title.into(),
            body: body.into(),
        }
    }

    fn fields() -> NoteFields {
        NoteFields {
            business_name: "Marsh  Hollow\nCarpentry".into(),
            period_start: NaiveDate::from_ymd_opt(2025, 4, 1).unwrap(),
            balance_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
            depreciation_methods: vec![
                "Tools and equipment: 25% diminishing value".into(),
                "Vehicles: 30% diminishing value".into(),
            ],
        }
    }

    #[test]
    fn fills_fields_and_splits_paragraphs() {
        let p = para(
            "basis",
            Placement::Policy,
            "Basis",
            "{business_name} covers {period_start} to {balance_date}.  \r\n\r\n\
             Rates:\n{depreciation_methods}\n\n\n{{literal}}",
        );
        assert_eq!(
            fill(&p, &fields()).unwrap(),
            vec![
                "Marsh Hollow Carpentry covers 1 April 2025 to 31 March 2026.",
                "Rates:\nTools and equipment: 25% diminishing value\n\
                 Vehicles: 30% diminishing value",
                "{literal}",
            ]
        );
    }

    #[test]
    fn an_unknown_field_fails_loudly() {
        let p = para("x", Placement::Note, "X", "For {owner_name} and {nope}.");
        let errors = fill(&p, &fields()).unwrap_err();
        assert_eq!(
            errors,
            vec![
                NoteError::UnknownField {
                    paragraph: key("x"),
                    field: "owner_name".into()
                },
                NoteError::UnknownField {
                    paragraph: key("x"),
                    field: "nope".into()
                },
            ]
        );
        assert_eq!(check(&p).unwrap_err(), errors);
    }

    #[test]
    fn an_empty_field_fails_loudly() {
        let p = para(
            "dep",
            Placement::Policy,
            "Depreciation",
            "{depreciation_methods}",
        );
        let none = NoteFields {
            depreciation_methods: Vec::new(),
            ..fields()
        };
        assert!(check(&p).is_ok());
        assert_eq!(
            fill(&p, &none).unwrap_err(),
            vec![NoteError::EmptyField {
                paragraph: key("dep"),
                field: "depreciation_methods".into()
            }]
        );
        let blank_name = NoteFields {
            business_name: "  ".into(),
            ..fields()
        };
        let p = para("b", Placement::Note, "B", "{business_name}");
        assert!(matches!(
            fill(&p, &blank_name).unwrap_err()[..],
            [NoteError::EmptyField { .. }]
        ));
    }

    #[test]
    fn stray_braces_titles_and_bodies_are_checked() {
        for body in [
            "a { b",
            "a } b",
            "{Business_Name}",
            "{}",
            "{ business_name }",
        ] {
            let p = para("s", Placement::Note, "S", body);
            assert!(
                matches!(check(&p).unwrap_err()[..], [NoteError::StrayBrace { .. }]),
                "{body}"
            );
        }
        let p = para("e", Placement::Note, " ", "\n  \n");
        assert_eq!(
            check(&p).unwrap_err(),
            vec![
                NoteError::EmptyTitle {
                    paragraph: key("e")
                },
                NoteError::EmptyBody {
                    paragraph: key("e")
                }
            ]
        );
    }

    #[test]
    fn policies_go_in_note_one_and_notes_follow_in_order() {
        let ps = [
            para(
                "tax",
                Placement::Note,
                "Income tax",
                "Tax for {business_name}.",
            ),
            para("basis", Placement::Policy, "Basis of preparation", "Basis."),
            para("equity", Placement::Note, "Owner's equity", "Equity."),
            para("gst", Placement::Policy, "GST", "GST."),
        ];
        let notes = build_notes(&ps, &fields()).unwrap();
        let outline: Vec<(u32, &str, Vec<Option<&str>>)> = notes
            .iter()
            .map(|n| {
                (
                    n.number,
                    n.title.as_str(),
                    n.sections.iter().map(|s| s.title.as_deref()).collect(),
                )
            })
            .collect();
        assert_eq!(
            outline,
            vec![
                (
                    1,
                    POLICIES_TITLE,
                    vec![Some("Basis of preparation"), Some("GST")]
                ),
                (2, "Income tax", vec![None]),
                (3, "Owner's equity", vec![None]),
            ]
        );
        assert_eq!(
            notes[1].sections[0].text,
            vec!["Tax for Marsh Hollow Carpentry."]
        );
        // Without policies, notes start at 1.
        let notes = build_notes(&ps[2..3], &fields()).unwrap();
        assert_eq!((notes[0].number, notes[0].key.as_str()), (1, "equity"));
        assert!(build_notes(&[], &fields()).unwrap().is_empty());
    }

    #[test]
    fn build_reports_every_paragraphs_problems() {
        let ps = [
            para("a", Placement::Note, "A", "{nope}"),
            para("b", Placement::Policy, "B", "{depreciation_methods}"),
        ];
        let none = NoteFields {
            depreciation_methods: Vec::new(),
            ..fields()
        };
        assert_eq!(build_notes(&ps, &none).unwrap_err().len(), 2);
    }

    #[test]
    fn notes_are_byte_stable() {
        let ps = [
            para(
                "basis",
                Placement::Policy,
                "Basis",
                "{business_name} {balance_date}",
            ),
            para("tax", Placement::Note, "Tax", "{depreciation_methods}"),
        ];
        let a = serde_json::to_string(&build_notes(&ps, &fields()).unwrap()).unwrap();
        let b = serde_json::to_string(&build_notes(&ps, &fields()).unwrap()).unwrap();
        assert_eq!(a, b);
    }

    /// The sole-trader starter set: every paragraph checks, and the whole set fills in.
    #[test]
    fn the_starter_set_fills_in() {
        let set: Vec<Paragraph> =
            serde_json::from_str(include_str!("../../../fixtures/practice/paragraphs.json"))
                .unwrap();
        for p in &set {
            assert_eq!(check(p), Ok(()), "{}", p.key);
        }
        // A year picks one of the two GST policies.
        let picked: Vec<Paragraph> = set
            .into_iter()
            .filter(|p| p.key.as_str() != "gst_not_registered")
            .collect();
        let notes = build_notes(&picked, &fields()).unwrap();
        let mut text = String::new();
        for n in &notes {
            text.push_str(&format!("{}. {}\n", n.number, n.title));
            for s in &n.sections {
                if let Some(t) = &s.title {
                    text.push_str(&format!("  {t}\n"));
                }
                for para in &s.text {
                    text.push_str(&format!("    {}\n", para.replace('\n', "\n    ")));
                }
            }
        }
        insta::assert_snapshot!(text);
    }

    #[test]
    fn depreciation_lines_group_by_class() {
        let held = [
            ("Vehicles".to_owned(), Method::Dv { rate_bp: 3000 }),
            ("Tools".to_owned(), Method::Dv { rate_bp: 1250 }),
            ("Vehicles".to_owned(), Method::Dv { rate_bp: 3000 }),
            (
                "Vehicles".to_owned(),
                Method::Sl {
                    basis: SlBasis::Rate { rate_bp: 1075 },
                },
            ),
            (
                "Fitout".to_owned(),
                Method::Sl {
                    basis: SlBasis::Life { months: 60 },
                },
            ),
            (
                "Fitout".to_owned(),
                Method::Sl {
                    basis: SlBasis::Life { months: 18 },
                },
            ),
            ("Art".to_owned(), Method::None),
        ];
        assert_eq!(
            depreciation_methods(&held),
            vec![
                "Vehicles: 10.75% straight line; 30% diminishing value",
                "Tools: 12.5% diminishing value",
                "Fitout: straight line over 18 months; straight line over 5 years",
                "Art: not depreciated",
            ]
        );
        assert_eq!(percent(1), "0.01%");
        assert_eq!(
            long_date(NaiveDate::from_ymd_opt(2026, 1, 5).unwrap()),
            "5 January 2026"
        );
    }
}
