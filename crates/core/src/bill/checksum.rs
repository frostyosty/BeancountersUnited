//! The IRD number checksum, as `docs/domain.md` ("Tax invoices") sets it out. **check**: against IRD's
//! current specification before M23 is done.
//!
//! A GST number is the supplier's IRD number: 8 or 9 digits whose last digit is a check digit.

/// The first set of weights, applied to the 8 digits before the check digit.
const WEIGHTS_FIRST: [u32; 8] = [3, 2, 7, 6, 5, 4, 3, 2];
/// The second set, used when the first gives 10.
const WEIGHTS_SECOND: [u32; 8] = [7, 4, 3, 2, 5, 2, 7, 6];

/// The smallest valid IRD number.
const MIN_NUMBER: u32 = 10_000_000;
/// The largest valid IRD number.
const MAX_NUMBER: u32 = 150_000_000;

/// Strips spaces and hyphens from a GST number as printed ("123-456-785"), and returns its digits if
/// that leaves 8 or 9 of them and nothing else. This doesn't test the checksum.
pub fn normalise_gst_number(raw: &str) -> Option<String> {
    let digits: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    let ok = matches!(digits.len(), 8 | 9) && digits.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(digits)
}

/// Whether `number` (digits only, as [`normalise_gst_number`] returns) is a valid IRD number: 8 or 9
/// digits, between 10,000,000 and 150,000,000, whose check digit matches.
pub fn gst_number_valid(number: &str) -> bool {
    if !matches!(number.len(), 8 | 9) || !number.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let Ok(value) = number.parse::<u32>() else {
        return false;
    };
    if !(MIN_NUMBER..=MAX_NUMBER).contains(&value) {
        return false;
    }
    let (base, check) = number.split_at(number.len() - 1);
    let Some(check) = check.bytes().next().map(|b| u32::from(b - b'0')) else {
        return false;
    };
    expected_check_digit(base) == Some(check)
}

/// The check digit for `base` (the number without its last digit, 7 or 8 digits), or `None` if both
/// sets of weights give 10.
fn expected_check_digit(base: &str) -> Option<u32> {
    let digits = padded_digits(base);
    let first = check_digit(&digits, &WEIGHTS_FIRST);
    if first != 10 {
        return Some(first);
    }
    let second = check_digit(&digits, &WEIGHTS_SECOND);
    (second != 10).then_some(second)
}

/// Whether the first set of weights gives 10 for `base`, so the second set decides.
#[cfg(test)]
fn needs_second_weights(base: &str) -> bool {
    check_digit(&padded_digits(base), &WEIGHTS_FIRST) == 10
}

/// `base`'s digits, padded with leading zeros to 8.
fn padded_digits(base: &str) -> [u32; 8] {
    let mut out = [0u32; 8];
    let offset = 8usize.saturating_sub(base.len());
    for (slot, b) in out[offset..].iter_mut().zip(base.bytes()) {
        *slot = u32::from(b - b'0');
    }
    out
}

/// The check digit those weights give: 0 for a remainder of 0, otherwise 11 less the remainder
/// (which can be 10).
fn check_digit(digits: &[u32; 8], weights: &[u32; 8]) -> u32 {
    let sum: u32 = digits.iter().zip(weights).map(|(d, w)| d * w).sum();
    match sum % 11 {
        0 => 0,
        r => 11 - r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Invented numbers with valid checksums: docs/domain.md's, and the fixtures' (`fixtures/invoices`).
    const VALID: [&str; 6] = [
        "123456785",
        "135792462",
        "146813577",
        "110101015",
        "102030400",
        "112233445",
    ];

    #[test]
    fn invented_numbers_are_valid() {
        for n in VALID {
            assert!(gst_number_valid(n), "{n}");
        }
    }

    #[test]
    fn the_worked_example_adds_up() {
        // 12345678: 1×3 + 2×2 + 3×7 + 4×6 + 5×5 + 6×4 + 7×3 + 8×2 = 138; 138 mod 11 = 6; 11 − 6 = 5.
        assert_eq!(expected_check_digit("12345678"), Some(5));
        assert!(
            !gst_number_valid("123456786"),
            "the check digit should be 5"
        );
    }

    #[test]
    fn eight_digit_numbers_pad_with_a_zero() {
        // 8 digits: the base is 7, padded to 8. 1234567 → 01234567: 0×3 + 1×2 + 2×7 + 3×6 + 4×5
        // + 5×4 + 6×3 + 7×2 = 106; 106 mod 11 = 7; 11 − 7 = 4.
        assert_eq!(expected_check_digit("1234567"), Some(4));
        assert!(gst_number_valid("12345674"));
        assert!(!gst_number_valid("12345675"));
    }

    #[test]
    fn the_second_weights_decide_when_the_first_give_ten() {
        let base = (1_000_000u32..2_000_000)
            .map(|n| n.to_string())
            .find(|b| needs_second_weights(b))
            .expect("some base needs the second weights");
        match expected_check_digit(&base) {
            Some(c) => assert!(gst_number_valid(&format!("{base}{c}"))),
            // Both sets give 10: no check digit makes the number valid.
            None => assert!((0..10).all(|c| !gst_number_valid(&format!("{base}{c}")))),
        }
        // Find one of each kind, so both branches are exercised.
        let with_second = (1_000_000u32..2_000_000)
            .map(|n| n.to_string())
            .find(|b| needs_second_weights(b) && expected_check_digit(b).is_some())
            .expect("some base is saved by the second weights");
        let c = expected_check_digit(&with_second).expect("checked");
        assert!(gst_number_valid(&format!("{with_second}{c}")));
        let neither = (1_000_000u32..2_000_000)
            .map(|n| n.to_string())
            .find(|b| expected_check_digit(b).is_none())
            .expect("some base has no check digit");
        assert!((0..10).all(|c| !gst_number_valid(&format!("{neither}{c}"))));
    }

    #[test]
    fn a_remainder_of_zero_gives_a_check_digit_of_zero() {
        let base = (10_000_000u32..10_001_000)
            .map(|n| n.to_string())
            .find(|b| expected_check_digit(&b[..b.len() - 1]) == Some(0))
            .expect("some number has a zero check digit");
        let candidate = &base[..base.len() - 1];
        assert!(gst_number_valid(&format!("{candidate}0")));
    }

    #[test]
    fn rejects_what_isnt_an_ird_number() {
        assert!(!gst_number_valid(""));
        assert!(!gst_number_valid("1234567")); // too short
        assert!(!gst_number_valid("1234567890")); // too long
        assert!(!gst_number_valid("12345678a"));
        assert!(
            !gst_number_valid("123-456-785"),
            "dashes are stripped first"
        );
        assert!(!gst_number_valid(" 12345678"));
        assert!(!gst_number_valid("０１２３４５６７８"), "full-width digits");
    }

    #[test]
    fn rejects_numbers_outside_the_range() {
        // Valid check digits, out of range.
        let below = (0u32..1_000_000)
            .map(|n| format!("{n:07}"))
            .find_map(|b| expected_check_digit(&b).map(|c| format!("{b}{c}")))
            .expect("some number below the range has a check digit");
        assert!(!gst_number_valid(&below), "{below}");
        let above = (150_000_010u32..150_000_100)
            .map(|n| n.to_string())
            .find_map(|n| {
                let (b, _) = n.split_at(n.len() - 1);
                expected_check_digit(b).map(|c| format!("{b}{c}"))
            })
            .expect("some number above the range has a check digit");
        assert!(!gst_number_valid(&above), "{above}");
    }

    #[test]
    fn normalising_strips_spaces_and_hyphens() {
        assert_eq!(
            normalise_gst_number("123-456-785").as_deref(),
            Some("123456785")
        );
        assert_eq!(
            normalise_gst_number(" 123 456 785 ").as_deref(),
            Some("123456785")
        );
        assert_eq!(
            normalise_gst_number("12-345-678").as_deref(),
            Some("12345678")
        );
        assert_eq!(normalise_gst_number("GST 123-456-785"), None);
        assert_eq!(normalise_gst_number("1234567"), None);
        assert_eq!(normalise_gst_number(""), None);
    }

    /// A valid 9- or 8-digit number: a base in range, with its check digit when one exists.
    fn valid_numbers() -> impl Strategy<Value = String> {
        (1_000_000u32..15_000_000).prop_filter_map("the base needs a check digit", |base| {
            let base = base.to_string();
            expected_check_digit(&base).map(|c| format!("{base}{c}"))
        })
    }

    proptest! {
        /// Every number we build is valid, so the changes below start from something that passes.
        #[test]
        fn built_numbers_are_valid(n in valid_numbers()) {
            prop_assert!(gst_number_valid(&n));
        }

        /// Changing the check digit to anything else always fails: a base has only one.
        #[test]
        fn a_changed_check_digit_is_rejected(n in valid_numbers(), d in 0u8..10) {
            let (base, check) = n.split_at(n.len() - 1);
            prop_assume!(check != d.to_string());
            let candidate = format!("{base}{d}");
            prop_assert!(!gst_number_valid(&candidate));
        }

        /// Changing one digit of the base is rejected too, except that the checksum can't promise
        /// it when either base falls back to the second weights (a remainder of 1): the second
        /// weights can then land on the same check digit by chance. See the next test.
        #[test]
        fn a_changed_base_digit_is_rejected(n in valid_numbers(), at in 0usize..8, d in 0u8..10) {
            let (base, check) = n.split_at(n.len() - 1);
            prop_assume!(at < base.len());
            prop_assume!(base.as_bytes()[at] != b'0' + d);
            let mut changed = base.as_bytes().to_vec();
            changed[at] = b'0' + d;
            let changed = String::from_utf8(changed).expect("ASCII digits");
            prop_assume!(!needs_second_weights(base) && !needs_second_weights(&changed));
            let candidate = format!("{changed}{check}");
            prop_assert!(!gst_number_valid(&candidate));
        }
    }

    /// The honest limit of the rule: a change to a base digit can slip through when the second
    /// weights are involved. Pinned so nobody "fixes" the property test above to claim more.
    #[test]
    fn a_base_digit_change_can_slip_through_via_the_second_weights() {
        // 144698959 is valid; changing its fourth digit to 0 gives 144608959, also valid.
        assert!(gst_number_valid("144698959"));
        assert!(gst_number_valid("144608959"));
        assert!(needs_second_weights("14469895") || needs_second_weights("14460895"));
    }
}
