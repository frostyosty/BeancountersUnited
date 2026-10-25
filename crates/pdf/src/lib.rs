//! Renders a ReportDoc to PDF with embedded Typst (ADR 010).
//!
//! It only renders: every figure, rounding included, comes from the ReportDoc, which core builds.
//! The layout is a fixed template, `templates/statements.typ`, that reads the ReportDoc as JSON.
//! Fonts and the template are compiled into the binary and Typst gets no file system, clock or
//! network, so the same ReportDoc and [`PrintContext`] always give the same bytes.

use std::sync::LazyLock;

use acct_core::ReportDoc;
use serde::Serialize;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration, Smart};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;

const TEMPLATE: &str = include_str!("../templates/statements.typ");

/// Source Sans 3 (SIL Open Font License, `assets/fonts/OFL.txt`): the only fonts a PDF uses.
const FONTS: [&[u8]; 2] = [
    include_bytes!("../assets/fonts/SourceSans3-Regular.ttf"),
    include_bytes!("../assets/fonts/SourceSans3-Bold.ttf"),
];

/// The `/Creator` written into every PDF. Fixed, so it never varies between renders.
pub const CREATOR: &str = "White Label Accounting";

/// What's printed that isn't in the ReportDoc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrintContext {
    pub client_name: String,
    /// The practice preparing the statements, if there is one: a business an owner signed up with
    /// has none until an accountant accepts its invite.
    pub practice_name: Option<String>,
    /// A draft carries "Draft" on every page. Only a finalised year's snapshot prints without it.
    pub draft: bool,
    /// The SHA-256 of the ReportDoc's JSON, as hex: for a finalised year, the snapshot's stored
    /// hash. Each page's footer prints its first 12 characters, so a printout can be matched to
    /// its snapshot; it also seeds the PDF's document id.
    pub report_sha256: String,
}

impl PrintContext {
    /// The reference each page's footer prints.
    pub fn reference(&self) -> &str {
        self.report_sha256
            .get(..12)
            .unwrap_or(self.report_sha256.as_str())
    }
}

/// The template failed to compile or export. That's a bug in the template, never in the data.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the statements PDF couldn't be rendered: {0}")]
pub struct RenderError(pub String);

/// What the template reads as `/print.json`.
#[derive(Serialize)]
struct PrintInput<'a> {
    client_name: &'a str,
    practice_name: Option<&'a str>,
    draft: bool,
    reference: &'a str,
    notes_title: &'a str,
}

/// Renders the statements, the fixed asset schedule and the notes, in that order.
pub fn render(doc: &ReportDoc, ctx: &PrintContext) -> Result<Vec<u8>, RenderError> {
    let print = PrintInput {
        client_name: &ctx.client_name,
        practice_name: ctx.practice_name.as_deref(),
        draft: ctx.draft,
        reference: ctx.reference(),
        notes_title: acct_core::notes::NOTES_TITLE,
    };
    let world = StatementsWorld {
        doc: Bytes::new(serde_json::to_vec(doc).expect("ReportDocs serialise")),
        print: Bytes::new(serde_json::to_vec(&print).expect("print context serialises")),
    };
    let compiled = typst::compile::<PagedDocument>(&world).output;
    let result = compiled
        .map_err(|errors| describe(&errors))
        .and_then(|document| {
            let options = PdfOptions {
                ident: Smart::Custom(ctx.report_sha256.clone()),
                creator: Smart::Custom(Some(CREATOR.to_owned())),
                timestamp: None,
                ..PdfOptions::default()
            };
            typst_pdf::pdf(&document, &options).map_err(|errors| describe(&errors))
        });
    // Typst memoises across compiles. Nothing is shared between two renders, so drop it all
    // rather than let it grow on a small machine.
    typst::comemo::evict(0);
    result.map_err(RenderError)
}

fn describe(errors: &[typst::diag::SourceDiagnostic]) -> String {
    errors
        .iter()
        .map(|e| e.message.as_str())
        .collect::<Vec<_>>()
        .join("; ")
}

fn file_id(path: &str) -> FileId {
    let vpath = VirtualPath::new(path).expect("a valid virtual path");
    RootedPath::new(VirtualRoot::Project, vpath).intern()
}

static MAIN: LazyLock<FileId> = LazyLock::new(|| file_id("/statements.typ"));
static DOC: LazyLock<FileId> = LazyLock::new(|| file_id("/doc.json"));
static PRINT: LazyLock<FileId> = LazyLock::new(|| file_id("/print.json"));

static LIBRARY: LazyLock<LazyHash<Library>> = LazyLock::new(|| LazyHash::new(Library::default()));

static FONT_SET: LazyLock<(LazyHash<FontBook>, Vec<Font>)> = LazyLock::new(|| {
    let fonts: Vec<Font> = FONTS
        .iter()
        .flat_map(|data| Font::iter(Bytes::new(*data)))
        .collect();
    (LazyHash::new(FontBook::from_fonts(&fonts)), fonts)
});

/// Everything Typst can see: the template, the two JSON inputs and our fonts. No files, no
/// packages and no date.
struct StatementsWorld {
    doc: Bytes,
    print: Bytes,
}

impl World for StatementsWorld {
    fn library(&self) -> &LazyHash<Library> {
        &LIBRARY
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &FONT_SET.0
    }

    fn main(&self) -> FileId {
        *MAIN
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == *MAIN {
            Ok(Source::new(id, TEMPLATE.to_owned()))
        } else {
            Err(FileError::NotSource)
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == *DOC {
            Ok(self.doc.clone())
        } else if id == *PRINT {
            Ok(self.print.clone())
        } else if id == *MAIN {
            Ok(Bytes::from_string(TEMPLATE))
        } else {
            Err(FileError::AccessDenied)
        }
    }

    fn font(&self, index: usize) -> Option<Font> {
        FONT_SET.1.get(index).cloned()
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fonts_are_source_sans_3_regular_and_bold() {
        let (book, fonts) = &*FONT_SET;
        assert_eq!(fonts.len(), 2);
        let families: Vec<_> = book.families().map(|(name, _)| name.to_owned()).collect();
        assert_eq!(families, ["Source Sans 3"]);
    }

    #[test]
    fn the_reference_is_the_first_12_hex_characters() {
        let ctx = PrintContext {
            client_name: "X".to_owned(),
            practice_name: None,
            draft: false,
            report_sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                .to_owned(),
        };
        assert_eq!(ctx.reference(), "ba7816bf8f01");
    }
}
