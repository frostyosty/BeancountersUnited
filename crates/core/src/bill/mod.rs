//! Supplier bills: the fields a reader produces and the checks core always applies to them.
//!
//! A **bill** is a supplier's invoice or receipt (the invoice maker's invoices are a different
//! thing). Every stage that reads a file, whether UBL, a text layer, local OCR or the AI, hands over a
//! [`BillFields`]. [`assess`] then checks them, the same way whatever produced them, and says which
//! checks failed and what that means for the bill ([`BillVerdict`]). Readers only propose fields:
//! nothing here, or in any reader, decides an amount that reaches the ledger.
//!
//! The rules are in `docs/domain.md` ("Tax invoices", every rule marked **check** for the tax
//! specialist) and ADR 017 (1, 2, 9 and 13).
//!
//! Money is integer cents, rates are basis points, and boxes on a page are basis points of the page
//! (top-left origin). Nothing in this module does IO or reads a clock.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::money::Money;

pub mod checks;
pub mod checksum;
pub mod matching;

pub use checks::{
    BUYER_DETAIL_THRESHOLD, GST_ALLOWANCE_CAP, GST_ALLOWANCE_PER_LINE, assess, gst_allowance,
};
pub use checksum::{gst_number_valid, normalise_gst_number};

/// Which stage of the reading cascade produced a reading (ADR 017, 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Stage {
    /// An e-invoice (UBL XML), read field by field.
    Ubl,
    /// A PDF's text layer, read with the supplier's learned template.
    PdfTemplate,
    /// A PDF's text layer, read with the generic rules.
    PdfRules,
    /// A photo or scan read by local OCR, with the supplier's learned template.
    OcrTemplate,
    /// A photo or scan read by local OCR, with the generic rules.
    OcrRules,
    /// The AI reader, on the owner's request.
    Ai,
}

/// Which detail, beyond the buyer's name, an invoice over $1,000 shows to identify the buyer. The
/// detail itself is never stored, only which kind it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BuyerDetail {
    Address,
    Phone,
    Email,
    TradingName,
    Nzbn,
    Website,
}

/// One line of a bill, as shown on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BillLine {
    pub description: String,
    /// As shown: GST-exclusive or GST-inclusive according to
    /// [`BillFields::lines_include_gst`]. May be negative (a discount or a cash-rounding line).
    pub amount: Money,
}

/// A field of a bill that can be flagged as unclear and answered by the owner (ADR 017, 13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BillField {
    SupplierName,
    SupplierGstNumber,
    InvoiceNumber,
    Date,
    BuyerName,
    Subtotal,
    Gst,
    Total,
    /// The amount of the line at `index` in [`BillFields::lines`].
    LineAmount {
        index: u16,
    },
}

/// A rectangle on a page, in basis points of the page's width and height, from its top left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PageBox {
    pub x_bp: u32,
    pub y_bp: u32,
    pub w_bp: u32,
    pub h_bp: u32,
}

/// A field a reader couldn't be sure of: left empty in the reading, with its place on the page
/// kept so the owner can be shown it and asked what it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Unclear {
    pub field: BillField,
    /// The page, counted from 1.
    pub page: u16,
    pub bbox: PageBox,
}

/// One word of a page, as a PDF's text layer or OCR hands it over. A text layer's words have
/// confidence 100.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PageWord {
    pub text: String,
    /// The page, counted from 1.
    pub page: u16,
    pub bbox: PageBox,
    /// 0 to 100.
    pub confidence: u8,
}

/// Everything a reader finds on a bill. Amounts are integer cents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BillFields {
    pub supplier_name: Option<String>,
    /// Digits only, 8 or 9 (see [`normalise_gst_number`]).
    pub supplier_gst_number: Option<String>,
    pub invoice_number: Option<String>,
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    pub buyer_name: Option<String>,
    /// Which identifier of the buyer is shown, not its value.
    pub buyer_detail: Option<BuyerDetail>,
    /// ISO 4217 as shown; `None` is taken as NZD.
    pub currency: Option<String>,
    pub lines: Vec<BillLine>,
    /// Whether the lines include GST: receipts usually do, most invoices don't.
    pub lines_include_gst: bool,
    /// GST-exclusive.
    pub subtotal: Option<Money>,
    pub gst: Option<Money>,
    /// GST-inclusive.
    pub total: Option<Money>,
    /// Whether the bill says its total includes GST, or similar.
    pub says_gst_included: bool,
    pub stage: Stage,
    /// Fields a reader wasn't sure of (OCR only), left empty above. An unclear field counts as
    /// missing in every check.
    pub unclear: Vec<Unclear>,
    /// Fields the owner answered after they were flagged as unclear.
    pub typed: Vec<BillField>,
}

impl BillFields {
    /// A reading that has found nothing yet, for a reader to fill in.
    pub fn empty(stage: Stage) -> BillFields {
        BillFields {
            supplier_name: None,
            supplier_gst_number: None,
            invoice_number: None,
            date: None,
            buyer_name: None,
            buyer_detail: None,
            currency: None,
            lines: Vec::new(),
            lines_include_gst: false,
            subtotal: None,
            gst: None,
            total: None,
            says_gst_included: false,
            stage,
            unclear: Vec::new(),
            typed: Vec::new(),
        }
    }

    /// Whether the reader flagged `field` as unclear.
    pub fn is_unclear(&self, field: BillField) -> bool {
        self.unclear.iter().any(|u| u.field == field)
    }
}

/// What the checks make of a bill (ADR 017, 2). From worst to best, the first that applies wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BillVerdict {
    /// Every check that applies passes, and the bill charges GST.
    Holds,
    /// The numbers hold together, but the bill lacks something its size requires. It can be kept and
    /// matched, and confirming it releases nothing.
    Short,
    /// The numbers hold together and no GST is charged (an unregistered supplier). Nothing to claim.
    NoGstCharged,
    /// A reading check failed: the file was misread, or the invoice is wrong. It can't be confirmed.
    Fails,
}

/// What a failed check means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckGroup {
    /// The numbers hold together. A failure means the file was misread or the invoice is wrong.
    Reading,
    /// The fields the bill's size requires are there. A failure means the bill is genuine but short.
    Records,
}

/// Every check, in the order [`BillAssessment::checks`] lists them. The first eight are
/// [`CheckGroup::Reading`] checks, the rest [`CheckGroup::Records`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckName {
    TotalFound,
    LinesAddUp,
    SubtotalPlusGst,
    GstRateKnown,
    GstNotAboveRate,
    GstNotBelowRate,
    GstNumberChecksum,
    CurrencyNzd,
    SupplierName,
    Date,
    Description,
    SupplierGstNumber,
    GstBreakdown,
    BuyerIdentified,
}

impl CheckName {
    /// All checks, in order.
    pub const ALL: [CheckName; 14] = [
        CheckName::TotalFound,
        CheckName::LinesAddUp,
        CheckName::SubtotalPlusGst,
        CheckName::GstRateKnown,
        CheckName::GstNotAboveRate,
        CheckName::GstNotBelowRate,
        CheckName::GstNumberChecksum,
        CheckName::CurrencyNzd,
        CheckName::SupplierName,
        CheckName::Date,
        CheckName::Description,
        CheckName::SupplierGstNumber,
        CheckName::GstBreakdown,
        CheckName::BuyerIdentified,
    ];

    /// Which group this check belongs to.
    pub const fn group(self) -> CheckGroup {
        match self {
            CheckName::TotalFound
            | CheckName::LinesAddUp
            | CheckName::SubtotalPlusGst
            | CheckName::GstRateKnown
            | CheckName::GstNotAboveRate
            | CheckName::GstNotBelowRate
            | CheckName::GstNumberChecksum
            | CheckName::CurrencyNzd => CheckGroup::Reading,
            CheckName::SupplierName
            | CheckName::Date
            | CheckName::Description
            | CheckName::SupplierGstNumber
            | CheckName::GstBreakdown
            | CheckName::BuyerIdentified => CheckGroup::Records,
        }
    }
}

/// How a check came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckOutcome {
    Pass,
    Fail,
    /// The check doesn't apply to this bill, or its inputs are missing (a missing input is reported
    /// by the check that requires it).
    NotApplicable,
}

/// One check and its outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BillCheck {
    pub name: CheckName,
    pub group: CheckGroup,
    pub outcome: CheckOutcome,
}

/// How big a supply the bill is, by its GST-inclusive total, which decides what it must show.
/// $200.00 is in the first tier and $200.01 in the second; $1,000.00 is in the second and
/// $1,000.01 in the third. A bill with no usable total is [`BillTier::UpTo200`], and fails
/// [`CheckName::TotalFound`] anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BillTier {
    #[serde(rename = "up_to_200")]
    UpTo200,
    #[serde(rename = "over_200")]
    Over200,
    #[serde(rename = "over_1000")]
    Over1000,
}

/// What [`assess`] returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BillAssessment {
    pub tier: BillTier,
    /// Every check, in [`CheckName`] order.
    pub checks: Vec<BillCheck>,
    pub verdict: BillVerdict,
}

impl BillAssessment {
    /// How `name` came out.
    pub fn outcome(&self, name: CheckName) -> CheckOutcome {
        self.checks
            .iter()
            .find(|c| c.name == name)
            .map_or(CheckOutcome::NotApplicable, |c| c.outcome)
    }

    /// The checks that failed, in order.
    pub fn failed(&self) -> Vec<CheckName> {
        self.checks
            .iter()
            .filter(|c| c.outcome == CheckOutcome::Fail)
            .map(|c| c.name)
            .collect()
    }

    /// The checks of `group` that failed, in order.
    pub fn failed_in(&self, group: CheckGroup) -> Vec<CheckName> {
        self.checks
            .iter()
            .filter(|c| c.outcome == CheckOutcome::Fail && c.group == group)
            .map(|c| c.name)
            .collect()
    }
}
