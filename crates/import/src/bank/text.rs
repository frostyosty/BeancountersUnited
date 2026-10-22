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
