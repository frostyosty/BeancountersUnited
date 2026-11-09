//! The checks core always applies to a bill's fields, whatever stage read them (ADR 017, 1 and 2;
//! `docs/domain.md`, "Tax invoices"). Every rule is **check** for the tax specialist.
//!
//! [`assess`] returns every check by name with its group and outcome, and a verdict:
//! - any failed *reading* check (the numbers don't hold together) makes the verdict
//!   [`BillVerdict::Fails`];
//! - otherwise any failed *records* check (a field the bill's size requires is missing) makes it
//!   [`BillVerdict::Short`];
//! - otherwise a bill that shows nil GST and no GST number is [`BillVerdict::NoGstCharged`];
//! - otherwise it [`BillVerdict::Holds`].
//!
//! A field the reader flagged as unclear counts as missing, whatever value it holds. The GST rate
//! for the invoice date comes from [`crate::tax::gst`], never a literal.

use crate::coding::SUPPLY_INFO_THRESHOLD;
use crate::money::Money;
use crate::tax::gst::{gst_in_inclusive, gst_rate_bp};

use super::checksum::gst_number_valid;
use super::{
    BillAssessment, BillCheck, BillField, BillFields, BillTier, BillVerdict, CheckGroup, CheckName,
    CheckOutcome,
};

/// Over this GST-inclusive total (strictly), the buyer must be named and identified too: $1,000.00.
pub const BUYER_DETAIL_THRESHOLD: Money = Money::from_cents(100_000);

/// The GST shown may differ from the GST in the total by this much per line (plus one cent), so
/// that a supplier who works GST out line by line isn't failed for rounding.
pub const GST_ALLOWANCE_PER_LINE: Money = Money::from_cents(1);

/// The allowance never exceeds this, so a long invoice can't hide a GST-free item inside it.
pub const GST_ALLOWANCE_CAP: Money = Money::from_cents(50);

/// How far the GST shown may be from the GST in the total: 1 cent per line plus 1 cent, and never
/// more than [`GST_ALLOWANCE_CAP`].
pub fn gst_allowance(line_count: usize) -> Money {
    let lines = i64::try_from(line_count).unwrap_or(i64::MAX / 2);
    let per_line = GST_ALLOWANCE_PER_LINE.cents().saturating_mul(lines);
    let cents = per_line
        .saturating_add(GST_ALLOWANCE_PER_LINE.cents())
        .min(GST_ALLOWANCE_CAP.cents());
    Money::from_cents(cents)
}

/// Runs every check on `fields`.
pub fn assess(fields: &BillFields) -> BillAssessment {
    let view = View::of(fields);
    let tier = view.tier();
    let outcomes: Vec<CheckOutcome> = CheckName::ALL
        .iter()
        .map(|&name| view.outcome(name, tier))
        .collect();
    let checks: Vec<BillCheck> = CheckName::ALL
        .iter()
        .zip(&outcomes)
        .map(|(&name, &outcome)| BillCheck {
            name,
            group: name.group(),
            outcome,
        })
        .collect();
    let failed_in = |group: CheckGroup| {
        checks
            .iter()
            .any(|c| c.group == group && c.outcome == CheckOutcome::Fail)
    };
    let verdict = if failed_in(CheckGroup::Reading) {
        BillVerdict::Fails
    } else if failed_in(CheckGroup::Records) {
        BillVerdict::Short
    } else if view.no_gst_charged {
        BillVerdict::NoGstCharged
    } else {
        BillVerdict::Holds
    };
    BillAssessment {
        tier,
        checks,
        verdict,
    }
}

/// The fields with every unclear one taken as missing.
struct View<'a> {
    fields: &'a BillFields,
    total: Option<Money>,
    subtotal: Option<Money>,
    gst: Option<Money>,
    date: Option<chrono::NaiveDate>,
    supplier_name: Option<&'a str>,
    gst_number: Option<&'a str>,
    buyer_name: Option<&'a str>,
    /// A line's amount is unclear, so the lines can't be trusted to add up.
    line_amount_unclear: bool,
    /// GST shown as nil, with no GST number (and none flagged unclear): an unregistered supplier.
    no_gst_charged: bool,
}

/// A trimmed value that isn't blank.
fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

impl<'a> View<'a> {
    fn of(fields: &'a BillFields) -> View<'a> {
        let clear = |field: BillField| !fields.is_unclear(field);
        let gst = fields.gst.filter(|_| clear(BillField::Gst));
        let gst_number =
            text(&fields.supplier_gst_number).filter(|_| clear(BillField::SupplierGstNumber));
        let no_gst_charged =
            gst == Some(Money::ZERO) && gst_number.is_none() && clear(BillField::SupplierGstNumber);
        View {
            fields,
            total: fields.total.filter(|_| clear(BillField::Total)),
            subtotal: fields.subtotal.filter(|_| clear(BillField::Subtotal)),
            gst,
            date: fields.date.filter(|_| clear(BillField::Date)),
            supplier_name: text(&fields.supplier_name).filter(|_| clear(BillField::SupplierName)),
            gst_number,
            buyer_name: text(&fields.buyer_name).filter(|_| clear(BillField::BuyerName)),
            line_amount_unclear: fields
                .unclear
                .iter()
                .any(|u| matches!(u.field, BillField::LineAmount { .. })),
            no_gst_charged,
        }
    }

    /// The total, if it was found and is more than nothing (a credit note is out of scope).
    fn positive_total(&self) -> Option<Money> {
        self.total.filter(|t| t.cents() > 0)
    }

    fn tier(&self) -> BillTier {
        match self.positive_total() {
            Some(t) if t > BUYER_DETAIL_THRESHOLD => BillTier::Over1000,
            Some(t) if t > SUPPLY_INFO_THRESHOLD => BillTier::Over200,
            _ => BillTier::UpTo200,
        }
    }

    fn outcome(&self, name: CheckName, tier: BillTier) -> CheckOutcome {
        match name {
            CheckName::TotalFound => pass_if(self.positive_total().is_some()),
            CheckName::LinesAddUp => self.lines_add_up(),
            CheckName::SubtotalPlusGst => match (self.subtotal, self.gst, self.total) {
                (Some(s), Some(g), Some(t)) => pass_if(s.checked_add(g) == Some(t)),
                _ => CheckOutcome::NotApplicable,
            },
            CheckName::GstRateKnown => match self.date {
                Some(d) => pass_if(gst_rate_bp(d).is_some()),
                None => CheckOutcome::NotApplicable,
            },
            CheckName::GstNotAboveRate => self.gst_against_rate(|diff, allowance| diff > allowance),
            CheckName::GstNotBelowRate => {
                if self.no_gst_charged {
                    CheckOutcome::NotApplicable
                } else {
                    self.gst_against_rate(|diff, allowance| diff < -allowance)
                }
            }
            CheckName::GstNumberChecksum => match self.gst_number {
                Some(n) => pass_if(gst_number_valid(n)),
                None => CheckOutcome::NotApplicable,
            },
            CheckName::CurrencyNzd => match text(&self.fields.currency) {
                Some(c) => pass_if(c.eq_ignore_ascii_case("NZD")),
                None => CheckOutcome::Pass,
            },
            CheckName::SupplierName => pass_if(self.supplier_name.is_some()),
            CheckName::Date => pass_if(self.date.is_some()),
            CheckName::Description => pass_if(
                self.fields
                    .lines
                    .iter()
                    .any(|l| !l.description.trim().is_empty()),
            ),
            CheckName::SupplierGstNumber => {
                if self.needs_gst_details(tier, BillTier::Over200) {
                    pass_if(self.gst_number.is_some())
                } else {
                    CheckOutcome::NotApplicable
                }
            }
            CheckName::GstBreakdown => {
                if self.needs_gst_details(tier, BillTier::Over200) {
                    let all_three =
                        self.subtotal.is_some() && self.gst.is_some() && self.total.is_some();
                    let included = self.total.is_some() && self.fields.says_gst_included;
                    pass_if(all_three || included)
                } else {
                    CheckOutcome::NotApplicable
                }
            }
            CheckName::BuyerIdentified => {
                if self.needs_gst_details(tier, BillTier::Over1000) {
                    pass_if(self.buyer_name.is_some() && self.fields.buyer_detail.is_some())
                } else {
                    CheckOutcome::NotApplicable
                }
            }
        }
    }

    /// Whether a record the tier asks for applies: the bill is at least `from`'s size, and charges
    /// GST (a bill with no GST charged claims nothing, so it needs no GST number or buyer).
    fn needs_gst_details(&self, tier: BillTier, from: BillTier) -> bool {
        tier >= from && !self.no_gst_charged
    }

    /// The lines add to the subtotal when they exclude GST, or to the total when they include it.
    fn lines_add_up(&self) -> CheckOutcome {
        if self.line_amount_unclear {
            return CheckOutcome::Fail;
        }
        if self.fields.lines.is_empty() {
            return CheckOutcome::NotApplicable;
        }
        let target = if self.fields.lines_include_gst {
            self.total
        } else {
            // A bill that shows its total and GST but no subtotal has the subtotal between them.
            self.subtotal.or_else(|| match (self.total, self.gst) {
                (Some(t), Some(g)) => t.checked_sub(g),
                _ => None,
            })
        };
        let Some(target) = target else {
            return CheckOutcome::NotApplicable;
        };
        let sum = self
            .fields
            .lines
            .iter()
            .try_fold(Money::ZERO, |acc, l| acc.checked_add(l.amount));
        pass_if(sum == Some(target))
    }

    /// Compares the GST shown with the GST in the total at the rate for the date. `outside` is given
    /// the difference (shown less expected) and the allowance, and says whether that fails.
    fn gst_against_rate(&self, outside: impl Fn(Money, Money) -> bool) -> CheckOutcome {
        let (Some(total), Some(gst), Some(date)) = (self.positive_total(), self.gst, self.date)
        else {
            return CheckOutcome::NotApplicable;
        };
        let Some(rate) = gst_rate_bp(date) else {
            return CheckOutcome::NotApplicable;
        };
        let expected = gst_in_inclusive(total, rate);
        let Some(diff) = gst.checked_sub(expected) else {
            return CheckOutcome::Fail;
        };
        let allowance = gst_allowance(self.fields.lines.len());
        if outside(diff, allowance) {
            CheckOutcome::Fail
        } else {
            CheckOutcome::Pass
        }
    }
}

fn pass_if(ok: bool) -> CheckOutcome {
    if ok {
        CheckOutcome::Pass
    } else {
        CheckOutcome::Fail
    }
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use proptest::prelude::*;

    use super::*;
    use crate::bill::{BillLine, BuyerDetail, PageBox, Stage, Unclear};

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).expect("a real date")
    }

    fn c(cents: i64) -> Money {
        Money::from_cents(cents)
    }

    fn line(description: &str, cents: i64) -> BillLine {
        BillLine {
            description: description.to_string(),
            amount: c(cents),
        }
    }

    /// docs/domain.md's Bill 1: Tōtara Lane Timber, 300.00 + 45.00 = 345.00, no buyer named.
    fn bill1() -> BillFields {
        BillFields {
            supplier_name: Some("Totara Lane Timber Ltd".into()),
            supplier_gst_number: Some("123456785".into()),
            invoice_number: Some("2041".into()),
            date: Some(d(2026, 2, 3)),
            lines: vec![
                line("Timber, 90 x 45 H3.2, 12 lengths", 24_000),
                line("Galvanised nails, 5 kg", 6_000),
            ],
            subtotal: Some(c(30_000)),
            gst: Some(c(4_500)),
            total: Some(c(34_500)),
            ..BillFields::empty(Stage::PdfRules)
        }
    }

    /// docs/domain.md's Bill 2: Pūriri Plumbing, 1,200.00 + 180.00 = 1,380.00, "Cash sale".
    fn bill2() -> BillFields {
        BillFields {
            supplier_name: Some("Puriri Plumbing Ltd".into()),
            supplier_gst_number: Some("112233445".into()),
            date: Some(d(2026, 2, 8)),
            lines: vec![line("Hot water cylinder", 120_000)],
            subtotal: Some(c(120_000)),
            gst: Some(c(18_000)),
            total: Some(c(138_000)),
            ..BillFields::empty(Stage::PdfRules)
        }
    }

    /// docs/domain.md's Bill 3: a corner dairy receipt, two items at 3.50 including GST.
    fn bill3() -> BillFields {
        BillFields {
            supplier_name: Some("Corner Dairy".into()),
            date: Some(d(2026, 2, 10)),
            lines: vec![line("Milk 2 L", 350), line("Bread", 350)],
            lines_include_gst: true,
            gst: Some(c(92)),
            total: Some(c(700)),
            says_gst_included: true,
            ..BillFields::empty(Stage::PdfRules)
        }
    }

    /// An unregistered supplier: no GST number, GST 0.00, 64.00.
    fn unregistered() -> BillFields {
        BillFields {
            supplier_name: Some("Mata Pottery".into()),
            date: Some(d(2026, 3, 22)),
            lines: vec![line("Mug, hand thrown", 6_400)],
            subtotal: Some(c(6_400)),
            gst: Some(c(0)),
            total: Some(c(6_400)),
            ..BillFields::empty(Stage::PdfRules)
        }
    }

    fn outcome(f: &BillFields, name: CheckName) -> CheckOutcome {
        assess(f).outcome(name)
    }

    fn unclear(field: BillField) -> Unclear {
        Unclear {
            field,
            page: 1,
            bbox: PageBox {
                x_bp: 1_000,
                y_bp: 1_000,
                w_bp: 1_000,
                h_bp: 100,
            },
        }
    }

    // The worked examples (docs/domain.md): three bills and two failures.

    #[test]
    fn bill_1_holds() {
        let a = assess(&bill1());
        assert_eq!(a.verdict, BillVerdict::Holds);
        assert_eq!(a.tier, BillTier::Over200);
        assert!(a.failed().is_empty());
    }

    #[test]
    fn bill_2_is_short_for_want_of_the_buyer() {
        let a = assess(&bill2());
        assert_eq!(a.tier, BillTier::Over1000);
        assert_eq!(a.verdict, BillVerdict::Short);
        assert_eq!(a.failed(), vec![CheckName::BuyerIdentified]);
        assert_eq!(a.failed_in(CheckGroup::Reading), vec![]);
    }

    #[test]
    fn bill_2_holds_once_the_buyer_is_named_and_identified() {
        let mut f = bill2();
        f.buyer_name = Some("Ngahere Joinery Ltd".into());
        f.buyer_detail = Some(BuyerDetail::Address);
        assert_eq!(assess(&f).verdict, BillVerdict::Holds);
    }

    #[test]
    fn bill_3_holds_inside_the_allowance() {
        let a = assess(&bill3());
        assert_eq!(a.tier, BillTier::UpTo200);
        assert_eq!(a.verdict, BillVerdict::Holds);
        // The GST in 7.00 is 0.91; the receipt shows 0.92, 1 cent out, inside 3.
        assert_eq!(a.outcome(CheckName::GstNotAboveRate), CheckOutcome::Pass);
        assert_eq!(a.outcome(CheckName::GstNotBelowRate), CheckOutcome::Pass);
    }

    #[test]
    fn bill_1_with_gst_of_52_fails_the_rate_check() {
        let mut f = bill1();
        f.gst = Some(c(5_200));
        f.total = Some(c(35_200));
        let a = assess(&f);
        // It adds up, but the GST in 352.00 is 45.91, and 52.00 is 6.09 over.
        assert_eq!(a.outcome(CheckName::SubtotalPlusGst), CheckOutcome::Pass);
        assert_eq!(a.failed(), vec![CheckName::GstNotAboveRate]);
        assert_eq!(a.verdict, BillVerdict::Fails);
    }

    #[test]
    fn bill_1_with_a_bad_gst_number_fails_the_checksum() {
        let mut f = bill1();
        f.supplier_gst_number = Some("123456786".into());
        let a = assess(&f);
        assert_eq!(a.failed(), vec![CheckName::GstNumberChecksum]);
        assert_eq!(a.verdict, BillVerdict::Fails);
    }

    // One test per rule, each with a rejecting case.

    #[test]
    fn every_check_is_listed_in_order_with_its_group() {
        let a = assess(&bill1());
        let names: Vec<_> = a.checks.iter().map(|c| c.name).collect();
        assert_eq!(names, CheckName::ALL.to_vec());
        assert!(a.checks.iter().all(|c| c.group == c.name.group()));
        assert_eq!(
            a.checks
                .iter()
                .filter(|c| c.group == CheckGroup::Reading)
                .count(),
            8
        );
        assert!(
            a.checks
                .windows(2)
                .all(|w| w[0].name < w[1].name && w[0].group <= w[1].group)
        );
    }

    #[test]
    fn total_found_rejects_a_missing_zero_or_negative_total() {
        for total in [None, Some(c(0)), Some(c(-34_500))] {
            let mut f = bill1();
            f.total = total;
            assert_eq!(
                outcome(&f, CheckName::TotalFound),
                CheckOutcome::Fail,
                "{total:?}"
            );
            assert_eq!(assess(&f).verdict, BillVerdict::Fails);
        }
        assert_eq!(outcome(&bill1(), CheckName::TotalFound), CheckOutcome::Pass);
    }

    #[test]
    fn lines_add_up_to_the_subtotal_when_they_exclude_gst() {
        let mut f = bill1();
        f.lines[1].amount = c(6_001);
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::LinesAddUp), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Fails);
    }

    #[test]
    fn lines_add_up_to_the_total_when_they_include_gst() {
        let mut f = bill3();
        assert_eq!(outcome(&f, CheckName::LinesAddUp), CheckOutcome::Pass);
        f.lines[0].amount = c(351);
        assert_eq!(outcome(&f, CheckName::LinesAddUp), CheckOutcome::Fail);
    }

    #[test]
    fn a_discount_line_is_a_negative_line() {
        let mut f = bill1();
        f.lines.push(line("Trade discount", -1_000));
        assert_eq!(outcome(&f, CheckName::LinesAddUp), CheckOutcome::Fail);
        f.subtotal = Some(c(29_000));
        f.gst = Some(c(4_350));
        f.total = Some(c(33_350));
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::LinesAddUp), CheckOutcome::Pass);
        assert_eq!(a.verdict, BillVerdict::Holds);
    }

    #[test]
    fn lines_without_a_subtotal_add_to_the_total_less_the_gst() {
        let mut f = bill1();
        f.subtotal = None;
        assert_eq!(outcome(&f, CheckName::LinesAddUp), CheckOutcome::Pass);
        f.lines[0].amount = c(24_100);
        assert_eq!(outcome(&f, CheckName::LinesAddUp), CheckOutcome::Fail);
    }

    #[test]
    fn lines_add_up_doesnt_apply_with_nothing_to_compare_to() {
        let mut f = bill1();
        f.lines.clear();
        assert_eq!(
            outcome(&f, CheckName::LinesAddUp),
            CheckOutcome::NotApplicable
        );
        let mut g = bill1();
        g.subtotal = None;
        g.gst = None;
        assert_eq!(
            outcome(&g, CheckName::LinesAddUp),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn subtotal_plus_gst_must_be_the_total_to_the_cent() {
        let mut f = bill1();
        f.total = Some(c(34_501));
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::SubtotalPlusGst), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Fails);
        f.subtotal = None;
        assert_eq!(
            outcome(&f, CheckName::SubtotalPlusGst),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn a_date_with_no_gst_rate_fails() {
        let mut f = bill1();
        f.date = Some(d(2009, 12, 31));
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::GstRateKnown), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Fails);
        // And with no rate there's nothing to compare the GST with.
        assert_eq!(
            a.outcome(CheckName::GstNotAboveRate),
            CheckOutcome::NotApplicable
        );
        assert_eq!(
            a.outcome(CheckName::GstNotBelowRate),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn the_rate_comes_from_the_date_not_a_literal() {
        // On the day the 15% rate began, it applies; the day before there's no rate.
        let mut f = bill1();
        f.date = Some(d(2010, 10, 1));
        assert_eq!(assess(&f).verdict, BillVerdict::Holds);
        f.date = Some(d(2010, 9, 30));
        assert_eq!(assess(&f).verdict, BillVerdict::Fails);
    }

    #[test]
    fn gst_above_the_rate_fails_and_gst_below_it_fails() {
        // A receipt of 345.00 (the GST in it is 45.00), shown with the wrong GST.
        let with_gst = |cents: i64| {
            let mut f = receipt(&[17_250, 17_250]);
            f.gst = Some(c(cents));
            assess(&f)
        };
        let above = with_gst(5_000);
        assert_eq!(
            above.outcome(CheckName::GstNotAboveRate),
            CheckOutcome::Fail
        );
        assert_eq!(
            above.outcome(CheckName::GstNotBelowRate),
            CheckOutcome::Pass
        );
        assert_eq!(above.verdict, BillVerdict::Fails);
        // Some items carry no GST, so the GST shown is under the rate's share.
        let below = with_gst(3_000);
        assert_eq!(
            below.outcome(CheckName::GstNotBelowRate),
            CheckOutcome::Fail
        );
        assert_eq!(
            below.outcome(CheckName::GstNotAboveRate),
            CheckOutcome::Pass
        );
        assert_eq!(below.verdict, BillVerdict::Fails);
        assert!(with_gst(4_500).failed_in(CheckGroup::Reading).is_empty());
    }

    #[test]
    fn the_allowance_is_a_cent_a_line_plus_one_capped_at_fifty() {
        assert_eq!(gst_allowance(0), c(1));
        assert_eq!(gst_allowance(2), c(3));
        assert_eq!(gst_allowance(49), c(50));
        assert_eq!(gst_allowance(200), c(50));
        assert_eq!(gst_allowance(usize::MAX), c(50));
    }

    #[test]
    fn the_allowance_edge_is_inside_and_one_cent_past_it_is_outside() {
        // Bill 1 has 2 lines, so 3 cents. The GST in 345.00 is 45.00.
        let mut f = bill1();
        f.lines_include_gst = true;
        f.subtotal = None;
        f.lines = vec![line("Everything", 17_250), line("Everything else", 17_250)];
        f.says_gst_included = true;
        for (gst, expected) in [
            (4_503, CheckOutcome::Pass),
            (4_504, CheckOutcome::Fail),
            (4_497, CheckOutcome::Pass),
            (4_496, CheckOutcome::Fail),
        ] {
            f.gst = Some(c(gst));
            let a = assess(&f);
            let got = if a
                .failed()
                .iter()
                .any(|n| matches!(n, CheckName::GstNotAboveRate | CheckName::GstNotBelowRate))
            {
                CheckOutcome::Fail
            } else {
                CheckOutcome::Pass
            };
            assert_eq!(got, expected, "gst {gst}");
        }
    }

    #[test]
    fn the_gst_number_must_pass_the_checksum_when_shown() {
        let mut f = bill1();
        f.supplier_gst_number = Some("12345678".into()); // 8 digits, wrong check digit
        assert_eq!(
            outcome(&f, CheckName::GstNumberChecksum),
            CheckOutcome::Fail
        );
        f.supplier_gst_number = Some("123-456-785".into()); // digits only, so dashes fail
        assert_eq!(
            outcome(&f, CheckName::GstNumberChecksum),
            CheckOutcome::Fail
        );
        f.supplier_gst_number = Some("123456785".into());
        assert_eq!(
            outcome(&f, CheckName::GstNumberChecksum),
            CheckOutcome::Pass
        );
        f.supplier_gst_number = None;
        assert_eq!(
            outcome(&f, CheckName::GstNumberChecksum),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn the_currency_must_be_nzd_or_unnamed() {
        let mut f = bill1();
        assert_eq!(outcome(&f, CheckName::CurrencyNzd), CheckOutcome::Pass);
        f.currency = Some("nzd".into());
        assert_eq!(outcome(&f, CheckName::CurrencyNzd), CheckOutcome::Pass);
        f.currency = Some("AUD".into());
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::CurrencyNzd), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Fails);
    }

    #[test]
    fn the_supplier_name_is_needed_at_every_size() {
        for mut f in [bill1(), bill3()] {
            f.supplier_name = Some("  ".into());
            let a = assess(&f);
            assert_eq!(a.outcome(CheckName::SupplierName), CheckOutcome::Fail);
            assert_eq!(a.verdict, BillVerdict::Short);
            f.supplier_name = None;
            assert_eq!(outcome(&f, CheckName::SupplierName), CheckOutcome::Fail);
        }
    }

    #[test]
    fn the_date_is_needed_at_every_size() {
        for mut f in [bill1(), bill3()] {
            f.date = None;
            let a = assess(&f);
            assert_eq!(a.outcome(CheckName::Date), CheckOutcome::Fail);
            assert_eq!(a.verdict, BillVerdict::Short);
            // With no date there's no rate, and the rate checks wait for it.
            assert_eq!(
                a.outcome(CheckName::GstRateKnown),
                CheckOutcome::NotApplicable
            );
        }
    }

    #[test]
    fn a_description_is_needed_at_every_size() {
        let mut f = bill1();
        f.lines[0].description = " ".into();
        assert_eq!(outcome(&f, CheckName::Description), CheckOutcome::Pass);
        f.lines[1].description = String::new();
        assert_eq!(outcome(&f, CheckName::Description), CheckOutcome::Fail);
        f.lines.clear();
        assert_eq!(outcome(&f, CheckName::Description), CheckOutcome::Fail);
    }

    #[test]
    fn the_gst_number_is_needed_over_200_but_not_up_to_it() {
        let mut f = bill1();
        f.supplier_gst_number = None;
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::SupplierGstNumber), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Short);
        let mut small = bill3();
        small.supplier_gst_number = None;
        assert_eq!(
            outcome(&small, CheckName::SupplierGstNumber),
            CheckOutcome::NotApplicable
        );
        assert_eq!(assess(&small).verdict, BillVerdict::Holds);
    }

    #[test]
    fn the_gst_breakdown_is_needed_over_200() {
        // All three shown: pass.
        assert_eq!(
            outcome(&bill1(), CheckName::GstBreakdown),
            CheckOutcome::Pass
        );
        // Total and a statement that it includes GST: pass.
        let mut included = bill1();
        included.subtotal = None;
        included.gst = None;
        included.says_gst_included = true;
        assert_eq!(
            outcome(&included, CheckName::GstBreakdown),
            CheckOutcome::Pass
        );
        // The total alone: fail.
        included.says_gst_included = false;
        let a = assess(&included);
        assert_eq!(a.outcome(CheckName::GstBreakdown), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Short);
        // The GST and total but no subtotal and no statement: fail, since it's neither form.
        let mut no_subtotal = bill1();
        no_subtotal.subtotal = None;
        assert_eq!(
            outcome(&no_subtotal, CheckName::GstBreakdown),
            CheckOutcome::Fail
        );
        // Not needed up to $200.
        let mut small = bill3();
        small.says_gst_included = false;
        assert_eq!(
            outcome(&small, CheckName::GstBreakdown),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn the_buyer_is_needed_over_1000_by_name_and_one_more_detail() {
        let mut f = bill2();
        assert_eq!(outcome(&f, CheckName::BuyerIdentified), CheckOutcome::Fail);
        f.buyer_name = Some("Ngahere Joinery Ltd".into());
        assert_eq!(outcome(&f, CheckName::BuyerIdentified), CheckOutcome::Fail); // no detail
        f.buyer_name = None;
        f.buyer_detail = Some(BuyerDetail::Email);
        assert_eq!(outcome(&f, CheckName::BuyerIdentified), CheckOutcome::Fail); // no name
        f.buyer_name = Some("Ngahere Joinery Ltd".into());
        assert_eq!(outcome(&f, CheckName::BuyerIdentified), CheckOutcome::Pass);
        // Not needed at or below $1,000.
        assert_eq!(
            outcome(&bill1(), CheckName::BuyerIdentified),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn the_tiers_split_at_exactly_200_and_1000() {
        // The tier by total; everything else is held steady with one line including GST.
        let tier_of = |cents: i64| {
            let mut f = bill1();
            f.lines_include_gst = true;
            f.lines = vec![line("Goods", cents)];
            f.subtotal = None;
            f.total = Some(c(cents));
            f.gst = Some(gst_in_inclusive(c(cents), 1_500));
            assess(&f).tier
        };
        assert_eq!(tier_of(20_000), BillTier::UpTo200);
        assert_eq!(tier_of(20_001), BillTier::Over200);
        assert_eq!(tier_of(100_000), BillTier::Over200);
        assert_eq!(tier_of(100_001), BillTier::Over1000);
    }

    // No GST charged.

    #[test]
    fn nil_gst_with_no_gst_number_is_no_gst_charged() {
        let a = assess(&unregistered());
        assert_eq!(a.verdict, BillVerdict::NoGstCharged);
        assert_eq!(
            a.outcome(CheckName::GstNotBelowRate),
            CheckOutcome::NotApplicable
        );
        assert!(a.failed().is_empty());
    }

    #[test]
    fn a_no_gst_bill_needs_no_gst_number_breakdown_or_buyer_even_when_large() {
        let mut f = unregistered();
        f.lines = vec![line("Kiln firing", 150_000)];
        f.subtotal = Some(c(150_000));
        f.total = Some(c(150_000));
        let a = assess(&f);
        assert_eq!(a.tier, BillTier::Over1000);
        assert_eq!(a.verdict, BillVerdict::NoGstCharged);
        assert_eq!(
            a.outcome(CheckName::SupplierGstNumber),
            CheckOutcome::NotApplicable
        );
        assert_eq!(
            a.outcome(CheckName::GstBreakdown),
            CheckOutcome::NotApplicable
        );
        assert_eq!(
            a.outcome(CheckName::BuyerIdentified),
            CheckOutcome::NotApplicable
        );
    }

    #[test]
    fn a_missing_gst_figure_is_never_read_as_nil() {
        let mut f = unregistered();
        f.gst = None;
        f.subtotal = None;
        let a = assess(&f);
        assert_ne!(a.verdict, BillVerdict::NoGstCharged);
        assert_eq!(a.verdict, BillVerdict::Holds);
        // Over $200 with the GST missing, it's short for want of its breakdown and number.
        let mut big = bill1();
        big.gst = None;
        big.subtotal = None;
        big.supplier_gst_number = None;
        assert_eq!(assess(&big).verdict, BillVerdict::Short);
    }

    #[test]
    fn nil_gst_from_a_gst_registered_supplier_fails() {
        // A GST number with nil GST is a zero-rated or exempt supply: mixed-rate bills are out of
        // M23, and claiming 3/23 of it would over-claim.
        let mut f = unregistered();
        f.supplier_gst_number = Some("123456785".into());
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::GstNotBelowRate), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Fails);
    }

    #[test]
    fn an_unclear_gst_number_stops_a_bill_being_no_gst_charged() {
        let mut f = unregistered();
        f.unclear.push(unclear(BillField::SupplierGstNumber));
        let a = assess(&f);
        assert_ne!(a.verdict, BillVerdict::NoGstCharged);
        assert_eq!(a.outcome(CheckName::GstNotBelowRate), CheckOutcome::Fail);
    }

    // Unclear fields count as missing.

    #[test]
    fn an_unclear_gst_number_is_missing_so_the_bill_is_short() {
        let mut f = bill1();
        f.supplier_gst_number = None;
        f.unclear.push(unclear(BillField::SupplierGstNumber));
        let a = assess(&f);
        assert_eq!(a.failed(), vec![CheckName::SupplierGstNumber]);
        assert_eq!(a.verdict, BillVerdict::Short);
    }

    #[test]
    fn an_unclear_field_counts_as_missing_whatever_value_it_holds() {
        // A reader that left a guess in an unclear field gets no credit for it.
        let mut f = bill1();
        f.unclear.push(unclear(BillField::SupplierGstNumber));
        assert_eq!(
            outcome(&f, CheckName::SupplierGstNumber),
            CheckOutcome::Fail
        );
        assert_eq!(
            outcome(&f, CheckName::GstNumberChecksum),
            CheckOutcome::NotApplicable
        );
        let mut g = bill1();
        g.unclear.push(unclear(BillField::Total));
        assert_eq!(outcome(&g, CheckName::TotalFound), CheckOutcome::Fail);
        let mut h = bill1();
        h.unclear.push(unclear(BillField::Date));
        assert_eq!(outcome(&h, CheckName::Date), CheckOutcome::Fail);
        let mut n = bill1();
        n.unclear.push(unclear(BillField::SupplierName));
        assert_eq!(outcome(&n, CheckName::SupplierName), CheckOutcome::Fail);
    }

    #[test]
    fn an_unclear_total_fails_the_reading() {
        let mut f = bill1();
        f.total = None;
        f.unclear.push(unclear(BillField::Total));
        let a = assess(&f);
        assert_eq!(a.verdict, BillVerdict::Fails);
        assert_eq!(a.outcome(CheckName::TotalFound), CheckOutcome::Fail);
        assert_eq!(a.tier, BillTier::UpTo200);
    }

    #[test]
    fn an_unclear_line_amount_fails_the_lines_check() {
        let mut f = bill1();
        f.unclear.push(unclear(BillField::LineAmount { index: 1 }));
        let a = assess(&f);
        assert_eq!(a.outcome(CheckName::LinesAddUp), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Fails);
    }

    #[test]
    fn an_unclear_gst_figure_is_missing_so_it_cannot_be_compared() {
        let mut f = bill1();
        f.gst = None;
        f.unclear.push(unclear(BillField::Gst));
        let a = assess(&f);
        assert_eq!(
            a.outcome(CheckName::GstNotAboveRate),
            CheckOutcome::NotApplicable
        );
        assert_eq!(a.outcome(CheckName::GstBreakdown), CheckOutcome::Fail);
        assert_eq!(a.verdict, BillVerdict::Short);
    }

    #[test]
    fn a_typed_field_passes_or_fails_like_a_read_one() {
        let mut f = bill1();
        f.supplier_gst_number = Some("123456786".into());
        f.typed.push(BillField::SupplierGstNumber);
        assert_eq!(
            outcome(&f, CheckName::GstNumberChecksum),
            CheckOutcome::Fail
        );
        f.supplier_gst_number = Some("123456785".into());
        assert_eq!(assess(&f).verdict, BillVerdict::Holds);
    }

    #[test]
    fn the_verdict_takes_the_worst_group() {
        // A reading failure beats a records failure, which beats no GST charged.
        let mut f = bill2();
        f.gst = Some(c(25_000)); // wrong GST; and the buyer is missing too
        f.total = Some(c(145_000));
        assert_eq!(assess(&f).verdict, BillVerdict::Fails);
        let mut g = unregistered();
        g.supplier_name = None;
        assert_eq!(assess(&g).verdict, BillVerdict::Short);
    }

    // Every expected.json entry with fields gives its expected check results.

    #[test]
    fn every_fixture_gives_its_expected_checks() {
        #[derive(serde::Deserialize)]
        struct Expected {
            tier: BillTier,
            verdict: BillVerdict,
            failed: Vec<CheckName>,
        }
        let json = include_str!("../../../../fixtures/invoices/expected.json");
        let root: serde_json::Value = serde_json::from_str(json).expect("expected.json parses");
        let files = root["files"].as_object().expect("a files map");
        let mut checked = 0;
        for (name, entry) in files {
            let (Some(fields), Some(assessment)) = (entry.get("fields"), entry.get("assessment"))
            else {
                continue;
            };
            let fields: BillFields = serde_json::from_value(fields.clone())
                .unwrap_or_else(|e| panic!("{name}: fields don't parse: {e}"));
            let want: Expected = serde_json::from_value(assessment.clone())
                .unwrap_or_else(|e| panic!("{name}: assessment doesn't parse: {e}"));
            let got = assess(&fields);
            assert_eq!(got.tier, want.tier, "{name}: tier");
            assert_eq!(got.verdict, want.verdict, "{name}: verdict");
            assert_eq!(got.failed(), want.failed, "{name}: failed checks");
            checked += 1;
        }
        assert!(checked >= 20, "only {checked} fixtures had fields");
    }

    #[test]
    fn the_blurred_photo_is_short_with_its_gst_number_unclear() {
        let json = include_str!("../../../../fixtures/invoices/expected.json");
        let root: serde_json::Value = serde_json::from_str(json).expect("expected.json parses");
        let fields = root["files"]["photo-manuka-blurred.jpg"]["fields"].clone();
        let mut fields: BillFields = serde_json::from_value(fields).expect("fields parse");
        assert!(fields.is_unclear(BillField::SupplierGstNumber));
        let a = assess(&fields);
        assert_eq!(a.verdict, BillVerdict::Short);
        assert_eq!(a.failed(), vec![CheckName::SupplierGstNumber]);
        // The owner's answer completes it.
        fields.unclear.clear();
        fields.supplier_gst_number = Some("110101015".into());
        fields.typed.push(BillField::SupplierGstNumber);
        assert_eq!(assess(&fields).verdict, BillVerdict::Holds);
    }

    // Properties.

    /// A bill with lines that include GST and the GST for its total exactly: it holds.
    fn receipt(lines: &[i64]) -> BillFields {
        let total: i64 = lines.iter().sum();
        BillFields {
            supplier_name: Some("Some Shop".into()),
            date: Some(d(2026, 5, 1)),
            lines: lines.iter().map(|&a| line("Goods", a)).collect(),
            lines_include_gst: true,
            gst: Some(gst_in_inclusive(c(total), 1_500)),
            total: Some(c(total)),
            says_gst_included: true,
            ..BillFields::empty(Stage::PdfRules)
        }
    }

    proptest! {
        /// A receipt with its exact GST holds, however its lines are split.
        #[test]
        fn exact_gst_holds(lines in prop::collection::vec(1i64..500_000, 1..8)) {
            let f = receipt(&lines);
            let a = assess(&f);
            prop_assert!(a.failed_in(CheckGroup::Reading).is_empty(), "{:?}", a.failed());
        }

        /// GST off by more than the allowance, either way, never passes.
        #[test]
        fn gst_off_by_more_than_the_allowance_never_passes(
            lines in prop::collection::vec(1i64..500_000, 1..8),
            extra in 1i64..10_000,
            above in any::<bool>(),
        ) {
            let mut f = receipt(&lines);
            let allowance = gst_allowance(f.lines.len()).cents();
            let exact = f.gst.expect("set").cents();
            let off = allowance + extra;
            f.gst = Some(c(if above { exact + off } else { exact - off }));
            let a = assess(&f);
            prop_assert_eq!(a.verdict, BillVerdict::Fails);
            let name = if above { CheckName::GstNotAboveRate } else { CheckName::GstNotBelowRate };
            prop_assert_eq!(a.outcome(name), CheckOutcome::Fail);
        }

        /// GST off by no more than the allowance, either way, passes the rate checks.
        #[test]
        fn gst_within_the_allowance_passes(
            lines in prop::collection::vec(1i64..500_000, 1..8),
            within in 0i64..=60,
            above in any::<bool>(),
        ) {
            let mut f = receipt(&lines);
            let allowance = gst_allowance(f.lines.len()).cents();
            let off = within.min(allowance);
            let exact = f.gst.expect("set").cents();
            f.gst = Some(c(if above { exact + off } else { exact - off }));
            let a = assess(&f);
            prop_assert_eq!(a.outcome(CheckName::GstNotAboveRate), CheckOutcome::Pass);
            prop_assert_eq!(a.outcome(CheckName::GstNotBelowRate), CheckOutcome::Pass);
        }

        /// Lines that don't add up to the total by even a cent never pass.
        #[test]
        fn lines_off_by_any_amount_never_pass(
            lines in prop::collection::vec(1i64..500_000, 1..8),
            offset in prop_oneof![-100_000i64..=-1, 1i64..=100_000],
            which in any::<prop::sample::Index>(),
        ) {
            let mut f = receipt(&lines);
            let i = which.index(f.lines.len());
            f.lines[i].amount = c(f.lines[i].amount.cents() + offset);
            let a = assess(&f);
            prop_assert_eq!(a.outcome(CheckName::LinesAddUp), CheckOutcome::Fail);
            prop_assert_eq!(a.verdict, BillVerdict::Fails);
        }

        /// A subtotal and GST that don't sum to the total by even a cent never pass.
        #[test]
        fn subtotal_plus_gst_off_by_any_amount_never_passes(
            subtotal in 1i64..1_000_000,
            offset in prop_oneof![-1_000i64..=-1, 1i64..=1_000],
        ) {
            let gst = subtotal * 15 / 100;
            let mut f = BillFields {
                supplier_name: Some("Some Shop".into()),
                date: Some(d(2026, 5, 1)),
                lines: vec![line("Goods", subtotal)],
                subtotal: Some(c(subtotal)),
                gst: Some(c(gst)),
                total: Some(c(subtotal + gst + offset)),
                ..BillFields::empty(Stage::PdfRules)
            };
            f.says_gst_included = false;
            let a = assess(&f);
            prop_assert_eq!(a.outcome(CheckName::SubtotalPlusGst), CheckOutcome::Fail);
            prop_assert_eq!(a.verdict, BillVerdict::Fails);
        }

        /// The checks are always the same fourteen, in order, and the verdict follows them.
        #[test]
        fn the_assessment_is_well_formed(
            total in proptest::option::of(-10_000i64..300_000),
            gst in proptest::option::of(-1_000i64..60_000),
            subtotal in proptest::option::of(-10_000i64..300_000),
            name in proptest::option::of("[A-Za-z ]{0,10}"),
            number in proptest::option::of("[0-9]{7,10}"),
            lines in prop::collection::vec(-1_000i64..100_000, 0..5),
            include in any::<bool>(),
            says in any::<bool>(),
            has_date in any::<bool>(),
        ) {
            let f = BillFields {
                supplier_name: name,
                supplier_gst_number: number,
                date: has_date.then(|| d(2026, 5, 1)),
                lines: lines.iter().map(|&a| line("Goods", a)).collect(),
                lines_include_gst: include,
                subtotal: subtotal.map(c),
                gst: gst.map(c),
                total: total.map(c),
                says_gst_included: says,
                ..BillFields::empty(Stage::OcrRules)
            };
            let a = assess(&f);
            let names: Vec<_> = a.checks.iter().map(|x| x.name).collect();
            prop_assert_eq!(names, CheckName::ALL.to_vec());
            let reading_failed = !a.failed_in(CheckGroup::Reading).is_empty();
            let records_failed = !a.failed_in(CheckGroup::Records).is_empty();
            match a.verdict {
                BillVerdict::Fails => prop_assert!(reading_failed),
                BillVerdict::Short => prop_assert!(!reading_failed && records_failed),
                BillVerdict::Holds | BillVerdict::NoGstCharged => {
                    prop_assert!(!reading_failed && !records_failed)
                }
            }
            // Deterministic.
            prop_assert_eq!(assess(&f), a);
        }
    }
}
