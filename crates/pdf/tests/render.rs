//! What ADR 010 says to check about the PDF, over the golden ReportDocs. PDFs are never
//! snapshotted: the golden tests stay on the ReportDoc JSON (ADR 003), and these read the PDF back
//! with `lopdf` to check its text, fonts and metadata.

use acct_core::notes::{NoteFields, Paragraph, build_notes};
use acct_core::{ReportDoc, ReportRow, RowStyle};
use acct_pdf::{CREATOR, PrintContext, render};
use lopdf::{Document, Object};
use serde::Deserialize;

const FY2025: &str = include_str!("../../core/tests/snapshots/fixture__fy2025_reportdoc.snap");
const FY2026: &str = include_str!("../../core/tests/snapshots/fixture__fy2026_reportdoc.snap");
const SOLE_TRADER: &str =
    include_str!("../../core/tests/snapshots/sole_trader_statements__sole_trader_reportdoc.snap");
const PARAGRAPHS: &str = include_str!("../../../fixtures/practice/paragraphs.json");
const AMOUNTS: &str = include_str!("../../../fixtures/presentation/amounts.json");

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// The ReportDoc JSON inside an insta snapshot, after its header.
fn golden(snap: &str) -> ReportDoc {
    let json = snap.splitn(3, "---").nth(2).expect("a snapshot header");
    serde_json::from_str(json).expect("a ReportDoc")
}

/// The sole trader's statements with the starter set of notes, as a year that picked them all
/// (one GST policy) would show them.
fn sole_trader_with_notes() -> ReportDoc {
    let mut doc = golden(SOLE_TRADER);
    let paragraphs: Vec<Paragraph> = serde_json::from_str(PARAGRAPHS).unwrap();
    let picked: Vec<Paragraph> = paragraphs
        .into_iter()
        .filter(|p| p.key.as_str() != "gst_not_registered")
        .collect();
    let fields = NoteFields {
        business_name: "Marsh Hollow Gardening".to_owned(),
        period_start: doc.current_period.start,
        balance_date: doc.current_period.end,
        depreciation_methods: vec![
            "Tools and equipment: 25% diminishing value".to_owned(),
            "Vehicles: 30% diminishing value".to_owned(),
        ],
    };
    doc.notes = build_notes(&picked, &fields).unwrap();
    doc
}

fn goldens() -> Vec<(&'static str, ReportDoc)> {
    vec![
        ("fy2025", golden(FY2025)),
        ("fy2026", golden(FY2026)),
        ("sole trader", sole_trader_with_notes()),
    ]
}

fn ctx(draft: bool) -> PrintContext {
    PrintContext {
        client_name: "Example Widgets Limited".to_owned(),
        practice_name: Some("Synthetic Practice".to_owned()),
        draft,
        report_sha256: SHA.to_owned(),
    }
}

/// Each page's text, whitespace removed: extraction splits and joins runs unpredictably, and
/// whitespace never tells two figures apart.
fn pages(pdf: &[u8]) -> Vec<String> {
    let doc = Document::load_mem(pdf).unwrap();
    doc.get_pages()
        .keys()
        .map(|&n| squash(&doc.extract_text(&[n]).unwrap()))
        .collect()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// A whole-dollar amount as statements show it: the rule the shared vectors pin down.
fn shown(dollars: Option<i64>) -> String {
    let Some(d) = dollars else {
        return String::new();
    };
    if d == 0 {
        return "–".to_owned();
    }
    let digits = d.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    if d < 0 {
        format!("({grouped})")
    } else {
        grouped
    }
}

#[derive(Deserialize)]
struct Vectors {
    dollars: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    dollars: Option<i64>,
    text: String,
}

fn vectors() -> Vec<Vector> {
    serde_json::from_str::<Vectors>(AMOUNTS).unwrap().dollars
}

/// Every piece, in order, somewhere in `text`. Returns the first piece that's missing.
fn find_in_order<'a>(text: &str, pieces: &'a [String]) -> Result<(), &'a str> {
    let mut at = 0;
    for p in pieces {
        match text[at..].find(p.as_str()) {
            Some(i) => at += i + p.len(),
            None => return Err(p),
        }
    }
    Ok(())
}

/// What a row prints, in order: its label, then its amounts.
fn row_pieces(r: &ReportRow, has_prior: bool) -> Vec<String> {
    let mut out = vec![squash(&r.label)];
    if r.style != RowStyle::Heading {
        out.push(shown(r.current));
        if has_prior {
            out.push(shown(r.prior));
        }
    }
    out
}

/// Everything the document should print, in order: statements, the asset schedule, the notes.
fn expected_pieces(doc: &ReportDoc) -> Vec<String> {
    let has_prior = doc.prior_period.is_some();
    let mut out = Vec::new();
    for s in &doc.statements {
        out.push(squash(&s.title));
        for r in &s.rows {
            out.extend(row_pieces(r, has_prior));
        }
    }
    if let Some(schedule) = &doc.asset_schedule {
        out.push(squash(&schedule.title));
        for b in &schedule.blocks {
            out.push(squash(&b.title));
            for r in &b.rows {
                out.push(squash(&r.label));
                out.push(shown(r.current));
                if has_prior {
                    out.push(shown(r.prior));
                }
            }
        }
    }
    if !doc.notes.is_empty() {
        out.push(squash(acct_core::notes::NOTES_TITLE));
        for n in &doc.notes {
            out.push(format!("{}.{}", n.number, squash(&n.title)));
            for s in &n.sections {
                if let Some(t) = &s.title {
                    out.push(squash(t));
                }
                for t in &s.text {
                    out.push(squash(t));
                }
            }
        }
    }
    out.retain(|p| !p.is_empty());
    out
}

#[test]
fn the_test_formatter_follows_the_shared_vectors() {
    for v in vectors() {
        assert_eq!(shown(v.dollars), v.text, "{:?}", v.dollars);
    }
}

#[test]
fn every_vector_prints_as_the_vectors_say() {
    let mut doc = golden(SOLE_TRADER);
    let template = doc.statements[0].rows[1].clone();
    doc.statements.truncate(1);
    doc.notes.clear();
    doc.statements[0].rows = vectors()
        .iter()
        .enumerate()
        .map(|(i, v)| ReportRow {
            label: format!("Vector {i}"),
            current: v.dollars,
            prior: None,
            ..template.clone()
        })
        .collect();
    let text = pages(&render(&doc, &ctx(false)).unwrap()).concat();
    let vectors = vectors();
    for (i, v) in vectors.iter().enumerate() {
        // The row's label, then exactly its text, then the next row's label.
        let next = if i + 1 < vectors.len() {
            format!("Vector{}", i + 1)
        } else {
            "Page1of1".to_owned()
        };
        let expected = format!("Vector{i}{}{next}", v.text);
        assert!(text.contains(&expected), "{expected} not in {text}");
    }
}

#[test]
fn the_same_reportdoc_gives_the_same_bytes() {
    for (name, doc) in goldens() {
        let first = render(&doc, &ctx(true)).unwrap();
        let second = render(&doc, &ctx(true)).unwrap();
        assert!(first == second, "{name}: two renders differ");
        let json = serde_json::to_string(&doc).unwrap();
        let round_tripped: ReportDoc = serde_json::from_str(&json).unwrap();
        let third = render(&round_tripped, &ctx(true)).unwrap();
        assert!(first == third, "{name}: a JSON round trip changes the PDF");
    }
}

#[test]
fn there_are_no_timestamps_and_the_creator_is_fixed() {
    for (name, doc) in goldens() {
        let pdf = render(&doc, &ctx(false)).unwrap();
        let raw = String::from_utf8_lossy(&pdf);
        for key in [
            "CreationDate",
            "ModDate",
            "xmp:CreateDate",
            "xmp:ModifyDate",
            "xmp:MetadataDate",
        ] {
            assert!(!raw.contains(key), "{name}: the PDF has {key}");
        }
        let parsed = Document::load_mem(&pdf).unwrap();
        let info = parsed
            .trailer
            .get(b"Info")
            .and_then(Object::as_reference)
            .and_then(|id| parsed.get_dictionary(id))
            .unwrap();
        assert_eq!(
            info.get(b"Creator").unwrap().as_str().unwrap(),
            CREATOR.as_bytes()
        );
        // Typst writes no producer, so nothing version- or time-dependent is left in the info.
        assert!(
            info.get(b"Producer").is_err(),
            "{name}: unexpected producer"
        );
    }
}

#[test]
fn every_font_is_embedded_and_is_ours() {
    let pdf = render(&sole_trader_with_notes(), &ctx(true)).unwrap();
    let doc = Document::load_mem(&pdf).unwrap();
    let mut fonts = 0;
    for object in doc.objects.values() {
        let Ok(dict) = object.as_dict() else { continue };
        if dict.get(b"Type").and_then(Object::as_name).ok() != Some(b"Font".as_slice()) {
            continue;
        }
        let subtype = dict.get(b"Subtype").and_then(Object::as_name).unwrap();
        // A composite font's descriptor is on its descendant.
        let font = if subtype == b"Type0" {
            let descendants = dict.get(b"DescendantFonts").unwrap();
            let (_, descendants) = doc.dereference(descendants).unwrap();
            let first = &descendants.as_array().unwrap()[0];
            doc.dereference(first).unwrap().1.as_dict().unwrap()
        } else {
            dict
        };
        let name = String::from_utf8_lossy(font.get(b"BaseFont").unwrap().as_name().unwrap());
        if subtype == b"Type0" {
            assert!(
                name.contains("SourceSans3"),
                "a font that isn't ours: {name}"
            );
            continue;
        }
        assert!(
            name.contains("SourceSans3"),
            "a font that isn't ours: {name}"
        );
        let (_, descriptor) = doc
            .dereference(font.get(b"FontDescriptor").unwrap())
            .unwrap();
        let descriptor = descriptor.as_dict().unwrap();
        assert!(
            [b"FontFile".as_slice(), b"FontFile2", b"FontFile3"]
                .iter()
                .any(|k| descriptor.has(k)),
            "{name} isn't embedded"
        );
        fonts += 1;
    }
    assert!(
        fonts >= 2,
        "expected the regular and bold faces, found {fonts}"
    );
}

#[test]
fn every_row_label_and_amount_prints_in_order() {
    for (name, doc) in goldens() {
        let text = pages(&render(&doc, &ctx(false)).unwrap()).concat();
        let pieces = expected_pieces(&doc);
        if let Err(missing) = find_in_order(&text, &pieces) {
            panic!("{name}: {missing:?} is missing or out of order in:\n{text}");
        }
    }
}

#[test]
fn the_notes_print_after_the_statements() {
    let doc = sole_trader_with_notes();
    assert!(!doc.notes.is_empty());
    let pages = pages(&render(&doc, &ctx(false)).unwrap());
    // The notes start on a page of their own, after every statement.
    let notes = page_of(&pages, acct_core::notes::NOTES_TITLE);
    for s in &doc.statements {
        assert!(
            page_of(&pages, &s.title) < notes,
            "{} after the notes",
            s.title
        );
    }
    // Every note prints, numbered, in order.
    let text = pages[notes..].concat();
    let titles: Vec<String> = doc
        .notes
        .iter()
        .map(|n| squash(&format!("{}. {}", n.number, n.title)))
        .collect();
    if let Err(missing) = find_in_order(&text, &titles) {
        panic!("{missing} isn't in the notes in order");
    }
}

/// The sole trader's P&L stretched over several pages: every row repeated, each with a unique
/// label so the page it lands on can be found.
fn long_doc() -> ReportDoc {
    let mut doc = golden(SOLE_TRADER);
    let rows = doc.statements[0].rows.clone();
    doc.statements[0].rows = (0..8)
        .flat_map(|copy| {
            rows.iter().map(move |r| ReportRow {
                label: format!("Copy {copy} {}", r.label),
                ..r.clone()
            })
        })
        .collect();
    doc
}

fn page_of(pages: &[String], piece: &str) -> usize {
    let piece = squash(piece);
    pages
        .iter()
        .position(|p| p.contains(&piece))
        .unwrap_or_else(|| panic!("{piece} isn't on any page"))
}

#[test]
fn long_statements_break_pages_by_the_layout_rules() {
    let doc = long_doc();
    let pages = pages(&render(&doc, &ctx(false)).unwrap());
    let total = pages.len();
    assert!(
        total >= 4,
        "the long fixture should run over several pages, got {total}"
    );

    // Every page says which page it is.
    for (i, p) in pages.iter().enumerate() {
        assert!(
            p.contains(&format!("Page{}of{total}", i + 1)),
            "page {}",
            i + 1
        );
    }

    for s in &doc.statements {
        let first_row = &s.rows[0];
        let start = page_of(&pages, &s.title);
        // The statement's heading is on the same page as its first row.
        assert_eq!(start, page_of(&pages, &first_row.label), "{}", s.title);
        // Every later page it runs onto says "(continued)" and repeats the column headings.
        let end = page_of(&pages, &s.rows.last().unwrap().label);
        for p in &pages[start + 1..=end] {
            assert!(
                p.contains(&squash(&format!("{} (continued)", s.title))),
                "{p}"
            );
            assert!(p.contains("2026$"), "{p}");
        }
        // The page it starts on doesn't.
        assert!(!pages[start].contains("(continued)"));
        // A group heading is never left at the foot of a page.
        for pair in s.rows.windows(2) {
            if pair[0].style == RowStyle::Heading {
                assert_eq!(
                    page_of(&pages, &pair[0].label),
                    page_of(&pages, &pair[1].label),
                    "{} is parted from its first line",
                    pair[0].label
                );
            }
        }
    }
}

#[test]
fn a_draft_is_marked_on_every_page_and_a_final_is_not() {
    for (name, doc) in goldens() {
        let draft = pages(&render(&doc, &ctx(true)).unwrap());
        let reference = format!("Ref{}", &SHA[..12]);
        for (i, p) in draft.iter().enumerate() {
            assert!(
                p.contains("DRAFT") && p.contains("Draft:notfinalised"),
                "{name} draft page {}",
                i + 1
            );
            assert!(p.contains(&reference), "{name} page {}", i + 1);
        }
        let fin = pages(&render(&doc, &ctx(false)).unwrap());
        for (i, p) in fin.iter().enumerate() {
            assert!(
                !p.to_lowercase().contains("draft"),
                "{name} final page {}",
                i + 1
            );
            // The footer's hash matches the snapshot's.
            assert!(p.contains(&reference), "{name} final page {}", i + 1);
        }
    }
}

#[test]
fn unfinalised_comparatives_carry_the_notice_and_the_asterisk() {
    let mut doc = golden(FY2026);
    doc.comparatives = acct_core::Comparatives::Unfinalised;
    let pages = pages(&render(&doc, &ctx(true)).unwrap());
    assert!(
        pages[0].contains("Thecomparativesmaystillchange")
            || pages[0].contains("comparativesmaystillchange")
    );
    assert!(pages[0].contains("2025$*"));
    assert!(pages[0].contains("*Unfinalised."));
}
