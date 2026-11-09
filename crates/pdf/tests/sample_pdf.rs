//! Writes the sample statements PDF that the For accountants page offers for download:
//! `apps/web/public/samples/sample-statements.pdf`.
//!
//! It's the synthetic sole trader's golden ReportDoc (Marsh Hollow Gardening) with the practice's
//! starter notes, the same document `render.rs` checks. It's ignored so the normal test run never
//! writes files; run it again when the PDF's layout changes:
//!
//! ```text
//! cargo test -- --ignored write_sample_pdf
//! ```

use std::path::Path;

use acct_core::ReportDoc;
use acct_core::notes::{NoteFields, Paragraph, build_notes};
use acct_pdf::{PrintContext, render};

const SOLE_TRADER: &str =
    include_str!("../../core/tests/snapshots/sole_trader_statements__sole_trader_reportdoc.snap");
const PARAGRAPHS: &str = include_str!("../../../fixtures/practice/paragraphs.json");
const OUT: &str = "../../apps/web/public/samples/sample-statements.pdf";

#[test]
#[ignore = "writes the web app's sample PDF; run by hand"]
fn write_sample_pdf() {
    let json = SOLE_TRADER
        .splitn(3, "---")
        .nth(2)
        .expect("a snapshot header");
    let mut doc: ReportDoc = serde_json::from_str(json).expect("a ReportDoc");
    let paragraphs: Vec<Paragraph> = serde_json::from_str(PARAGRAPHS).expect("the paragraphs");
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
    doc.notes = build_notes(&picked, &fields).expect("the notes");

    let ctx = PrintContext {
        client_name: "Marsh Hollow Gardening".to_owned(),
        practice_name: Some("Sample Accountants Ltd".to_owned()),
        draft: false,
        // A sample has no snapshot to point at; the footer shows this placeholder reference.
        report_sha256: "5a3b1e".repeat(10) + "5a3b",
    };
    let bytes = render(&doc, &ctx).expect("the sample renders");

    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join(OUT);
    std::fs::create_dir_all(out.parent().expect("a parent")).expect("the samples folder");
    std::fs::write(&out, bytes).expect("the sample is written");
}
