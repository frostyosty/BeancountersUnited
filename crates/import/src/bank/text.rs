//! Helpers shared by the statement parsers: decoding, descriptions, account numbers, amounts
//! and dates.

use acct_core::Money;
use chrono::NaiveDate;

use super::Problem;

/// The file as text. UTF-8 (with or without a BOM) is read as is; anything else is read as
/// Windows-1252. Line endings become `\n`.
pub fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    };
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn windows_1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    match b {
        0x80..=0x9f => HIGH[usize::from(b - 0x80)],
        _ => char::from(b),
    }
}

/// The text fields joined in order with single spaces, uppercased, runs of whitespace collapsed
/// and the ends trimmed. Nothing else is stripped: reference numbers and card fragments tell
/// real transactions apart.
pub fn normalise_description<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for word in parts.into_iter().flat_map(str::split_whitespace) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word.to_uppercase());
    }
    out
}

/// A NZ bank account number in `BB-bbbb-AAAAAAA-SS` form, so the same account matches across
/// formats. Accepts separators of `-` or spaces, or 15 or 16 bare digits; a three-digit suffix
/// with a leading zero (`-000`) and an eight-digit base with a leading zero shorten to the usual
/// widths. Anything else comes back trimmed and uppercased, unchanged otherwise.
pub fn normalise_account(raw: &str) -> String {
    let trimmed = raw.trim();
    let parts: Vec<&str> = trimmed
        .split(['-', ' '])
        .filter(|p| !p.is_empty())
        .collect();
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let split = match parts.as_slice() {
        [bank, branch, base, suffix] if parts.iter().all(|p| all_digits(p)) => {
            Some((*bank, *branch, *base, *suffix))
        }
        [digits] if all_digits(digits) && (digits.len() == 15 || digits.len() == 16) => {
            Some((&digits[..2], &digits[2..6], &digits[6..13], &digits[13..]))
        }
        _ => None,
    };
    let Some((bank, branch, base, suffix)) = split else {
        return trimmed.to_uppercase();
    };
    let shorten = |s: &str, width: usize| {
        if s.len() == width + 1 && s.starts_with('0') {
            s[1..].to_owned()
        } else {
            s.to_owned()
        }
    };
    let ok = bank.len() <= 2 && branch.len() <= 4 && base.len() <= 8 && suffix.len() <= 3;
    if !ok {
        return trimmed.to_uppercase();
    }
    format!(
        "{bank:0>2}-{branch:0>4}-{:0>7}-{:0>2}",
        shorten(base, 7),
        shorten(suffix, 2)
    )
}

/// The first thing in `text` that looks like a NZ account number, normalised.
pub fn find_account(text: &str) -> Option<String> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '-'))
        .filter(|t| t.bytes().filter(u8::is_ascii_digit).count() >= 15)
        .map(normalise_account)
        .find(|a| a.len() == 18 && a.as_bytes()[2] == b'-')
}

/// A card number, masked to its last four digits as `XXXX-XXXX-XXXX-1234`, so a full card
/// number is never kept and the same card matches across formats whatever mask the file used.
///
/// Call it only on something already known to be a card's number: a card statement's account
/// id, or a card number field. It accepts, with `-` or spaces anywhere between the characters:
/// - 12 to 19 digits or mask characters (`X`, `*`, `•`) ending in four digits:
///   `XXXXXXXXXXXX1234`, `**** **** **** 1234`, or a full number;
/// - a short mask, or none, before the last four digits: `****1234`, `XXXX 1234`, `1234`.
///
/// A bare four digits is a card only because the caller says this is a card; a bank statement's
/// account id goes through [`normalise_account`] instead and is never masked. A separated
/// number that is laid out like a NZ bank account (`99-1001-0000123-00`) isn't a card.
pub fn normalise_card(raw: &str) -> Option<String> {
    mask_card(raw, 0)
}

/// [`normalise_card`], but a short mask needs at least `min_short_mask` mask characters before
/// the last four digits, so free text (a QIF account name) doesn't turn `Box 2025` into a card.
fn mask_card(raw: &str, min_short_mask: usize) -> Option<String> {
    let trimmed = raw.trim();
    let is_mask = |c: char| matches!(c, 'X' | 'x' | '*' | '•');
    let compact: Vec<char> = trimmed.chars().filter(|&c| c != '-' && c != ' ').collect();
    if compact.len() < 4 || compact.len() > 19 {
        return None;
    }
    let (head, last4) = compact.split_at(compact.len() - 4);
    if !last4.iter().all(char::is_ascii_digit) {
        return None;
    }
    let full = compact.len() >= 12 && head.iter().all(|&c| c.is_ascii_digit() || is_mask(c));
    let short =
        compact.len() < 12 && head.iter().all(|&c| is_mask(c)) && head.len() >= min_short_mask;
    if !(full || short) {
        return None;
    }
    let masked = compact.iter().any(|&c| is_mask(c));
    let separated = trimmed.contains(['-', ' ']);
    if !masked && separated && looks_like_nz_account(trimmed) {
        return None;
    }
    let last4: String = last4.iter().collect();
    Some(format!("XXXX-XXXX-XXXX-{last4}"))
}

/// Four groups of digits with a NZ bank account's widths: 2, 4, 7 or 8, and 2 or 3.
fn looks_like_nz_account(s: &str) -> bool {
    let parts: Vec<&str> = s.split(['-', ' ']).filter(|p| !p.is_empty()).collect();
    let widths: Vec<usize> = parts.iter().map(|p| p.len()).collect();
    matches!(widths.as_slice(), [2, 4, 7 | 8, 2 | 3])
}

/// The first thing in `text` that looks like a card number, masked (see [`normalise_card`]).
/// Text is free-form, so a short mask needs at least four mask characters (`****1234`), and a
/// bare four digits (`Visa 1234`, `Visa ending 1234`) is not taken as a card: it could as easily
/// be a year or a branch. The owner then says which card the file is for.
pub fn find_card(text: &str) -> Option<String> {
    let in_number = |c: char| c.is_ascii_digit() || matches!(c, 'X' | 'x' | '*' | '•' | '-' | ' ');
    let mut rest = text;
    while !rest.is_empty() {
        let start = rest.find(in_number)?;
        rest = &rest[start..];
        let end = rest.find(|c: char| !in_number(c)).unwrap_or(rest.len());
        if let Some(card) = mask_card(&rest[..end], 4) {
            return Some(card);
        }
        rest = &rest[end..];
    }
    None
}

/// An amount as a bank file writes it: `-86.40`, `+412.50`, `1,883.56`. Zeros beyond two
/// decimal places are dropped (`-86.4000`); any other third decimal is an error, never rounded.
pub fn parse_amount(raw: &str) -> Result<Money, String> {
    let s = raw.trim();
    let s = s.strip_prefix('+').unwrap_or(s);
    let s = match s.split_once('.') {
        Some((int, frac)) if frac.len() > 2 && frac[2..].bytes().all(|b| b == b'0') => {
            format!("{int}.{}", &frac[..2])
        }
        _ => s.to_owned(),
    };
    s.parse::<Money>().map_err(|e| e.to_string())
}

/// `dd/mm/yyyy` exactly as layout-A CSVs write it.
pub fn parse_dmy(raw: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(raw.trim(), "%d/%m/%Y").ok()
}

/// `yyyy-mm-dd`.
pub fn parse_iso(raw: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").ok()
}

/// A CSV file's records with their 1-based line numbers, fields trimmed. Blank lines are
/// skipped; records may have different numbers of fields (preambles and trailers).
pub fn csv_records(text: &str) -> Result<Vec<(u32, Vec<String>)>, Problem> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut out = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| Problem::Unreadable {
            row: e.position().and_then(|p| u32::try_from(p.line()).ok()),
            message: e.to_string(),
        })?;
        if record.iter().all(str::is_empty) {
            continue;
        }
        let row = record
            .position()
            .and_then(|p| u32::try_from(p.line()).ok())
            .unwrap_or(0);
        out.push((row, record.iter().map(str::to_owned).collect()));
    }
    Ok(out)
}

/// Whether a record is exactly these header names, ignoring case.
pub fn is_header(fields: &[String], names: &[&str]) -> bool {
    fields.len() == names.len()
        && fields
            .iter()
            .zip(names)
            .all(|(f, n)| f.eq_ignore_ascii_case(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_join_uppercase_and_collapse() {
        assert_eq!(
            normalise_description(["Pikorua  Cafe", "", " EFTPOS\tWellington "]),
            "PIKORUA CAFE EFTPOS WELLINGTON"
        );
        assert_eq!(normalise_description(["  "]), "");
    }

    #[test]
    fn account_numbers_normalise() {
        for raw in [
            "99-1001-0000123-00",
            "99 1001 0000123 00",
            "991001000012300",
            "99-1001-0000123-000",
            "9910010000123000",
            "99-1001-00000123-00",
            "99-1001-123-0",
        ] {
            assert_eq!(normalise_account(raw), "99-1001-0000123-00", "{raw}");
        }
        assert_eq!(normalise_account(" abc123 "), "ABC123");
    }

    #[test]
    fn finds_an_account_in_a_name() {
        assert_eq!(
            find_account("Harbourlight Cheque 99-1001-0000123-00").as_deref(),
            Some("99-1001-0000123-00")
        );
        assert_eq!(find_account("Cheque account"), None);
        assert_eq!(find_account("Call 0800-123-456"), None);
    }

    #[test]
    fn card_numbers_are_masked() {
        for raw in [
            "XXXXXXXXXXXX4417",
            "XXXX XXXX XXXX 4417",
            "xxxx-xxxx-xxxx-4417",
            "**** **** **** 4417",
            "9999000000004417",
            "9999 0000 0000 4417",
            "9999-000000-04417",
            "************4417",
            "****4417",
            "XXXX 4417",
            "x-4417",
            "4417",
            " 4417 ",
        ] {
            assert_eq!(
                normalise_card(raw).as_deref(),
                Some("XXXX-XXXX-XXXX-4417"),
                "{raw}"
            );
        }
        for raw in [
            "99-1001-0000123-00",
            "99 1001 0000123 000",
            "XXXX XXXX XXXX XXXX",
            "441",
            "12344417",
            "44X17",
            "XXXX-4417-XXXX",
            "99990000000000004417XX",
            "",
        ] {
            assert_eq!(normalise_card(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_full_card_number_keeps_only_its_last_four() {
        for raw in [
            "4000123456789010",
            "4000 1234 5678 9010",
            "4000-1234-5678-9010",
            "4000123456789019010",
        ] {
            let masked = normalise_card(raw).unwrap();
            assert_eq!(masked, "XXXX-XXXX-XXXX-9010", "{raw}");
            let digits: String = masked.chars().filter(char::is_ascii_digit).collect();
            assert_eq!(digits, "9010", "only the last four digits are kept: {raw}");
        }
        assert_eq!(
            find_card("Visa 4000 1234 5678 9010").as_deref(),
            Some("XXXX-XXXX-XXXX-9010")
        );
    }

    #[test]
    fn finds_a_card_in_a_name() {
        assert_eq!(
            find_card("Harbourlight Visa XXXX-XXXX-XXXX-4417").as_deref(),
            Some("XXXX-XXXX-XXXX-4417")
        );
        assert_eq!(
            find_card("Visa ****4417").as_deref(),
            Some("XXXX-XXXX-XXXX-4417")
        );
        assert_eq!(
            find_card("[Visa XXXX 4417]").as_deref(),
            Some("XXXX-XXXX-XXXX-4417")
        );
        // Free text: a bare four digits, or a short mask of fewer than four, isn't a card.
        assert_eq!(find_card("Visa ending 4417"), None);
        assert_eq!(find_card("Visa 4417"), None);
        assert_eq!(find_card("PO Box 2025"), None);
        assert_eq!(find_card("Visa x4417"), None);
        assert_eq!(find_card("Cheque 99-1001-0000123-00"), None);
    }

    #[test]
    fn amounts() {
        assert_eq!(parse_amount("-86.40"), Ok(Money::from_cents(-8640)));
        assert_eq!(parse_amount("+412.5"), Ok(Money::from_cents(41250)));
        assert_eq!(parse_amount("1,883.56"), Ok(Money::from_cents(188_356)));
        assert_eq!(parse_amount("-86.4000"), Ok(Money::from_cents(-8640)));
        assert!(parse_amount("-86.401").is_err());
        assert!(parse_amount("").is_err());
    }

    #[test]
    fn windows_1252_text_decodes() {
        assert_eq!(decode(b"Caf\xe9 \x93x\x94\r\n"), "Café “x”\n");
        assert_eq!(decode("\u{feff}a\r\nb".as_bytes()), "a\nb");
    }
}
