//! OFX: 1.x in SGML (leaf tags left unclosed) and 2.x in XML.
//!
//! Both are read by one tokenizer that treats `<TAG>text` as a value and `<TAG>` followed by
//! another tag as an aggregate opening, so closing tags are optional for leaves. Aggregates are
//! always closed, so a file that ends before `</OFX>` or inside a `STMTTRN` was cut off and is
//! refused ([`Problem::Truncated`]). Tags and the header are read in any case. Text decodes the
//! XML entities and numeric references, reads CDATA literally and drops comments.
//!
//! A bank that couldn't give us a statement says so in a `STATUS` (in the sign-on `SONRS`, or a
//! statement's `STMTTRNRS`): an error there is passed on as [`Problem::BankError`]. A file with no
//! bank or card statement says what it holds instead ([`Problem::UnsupportedSection`] for an
//! investment statement, say, or [`Problem::NoStatement`]).
//!
//! One statement for one NZD account is read: a bank statement (`STMTRS` in `BANKMSGSRSV1`,
//! account in `BANKACCTFROM`) or a credit card statement (`CCSTMTRS` in `CREDITCARDMSGSRSV1`,
//! card in `CCACCTFROM`). A card's `ACCTID` is masked to its last four digits (see
//! [`normalise_card`]). The description is `NAME` then `MEMO`. OFX has no opening balance;
//! `LEDGERBAL` gives the closing balance.
//!
//! OFX already signs card amounts from the account holder's point of view (a purchase is a
//! negative `TRNAMT`, a payment a positive one, and an amount owed a negative `BALAMT`), which is
//! our convention, so nothing is flipped.

use chrono::NaiveDate;

use super::text::{
    LineStarts, normalise_account, normalise_card, normalise_description, parse_amount,
};
use super::{Balance, ParserInfo, Problem, SourceSpan, Statement, StatementKind, StatementLine};

pub const SGML: ParserInfo = ParserInfo {
    id: "ofx-sgml-1",
    family: "ofx-sgml",
    version: 1,
    label: "OFX 1.x (SGML)",
};

pub const XML: ParserInfo = ParserInfo {
    id: "ofx-xml-1",
    family: "ofx-xml",
    version: 1,
    label: "OFX 2.x (XML)",
};

/// OFX 2: an XML declaration and an `OFX` processing instruction or root. Case doesn't matter.
pub fn detect_xml(text: &str) -> bool {
    let head = text.trim_start();
    starts_with_ci(head, "<?xml") && (find_ci(head, "<?OFX").is_some() || find_root(head).is_some())
}

/// OFX 1: the `OFXHEADER:` header block, or a bare `<OFX>` root without closed leaf tags. Case
/// doesn't matter.
pub fn detect_sgml(text: &str) -> bool {
    let head = text.trim_start();
    if starts_with_ci(head, "OFXHEADER:") {
        return find_root(head).is_some();
    }
    starts_with_ci(head, "<OFX>")
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.as_bytes()
        .get(..prefix.len())
        .is_some_and(|b| b.eq_ignore_ascii_case(prefix.as_bytes()))
}

/// Where an ASCII `needle` first appears in `s`, ignoring ASCII case. The index is a char
/// boundary because the needle starts with an ASCII byte.
fn find_ci(s: &str, needle: &str) -> Option<usize> {
    s.as_bytes()
        .windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Where the `<OFX>` root opens.
fn find_root(s: &str) -> Option<usize> {
    find_ci(s, "<OFX>")
}

enum Token {
    /// `<TAG>` followed by text: a value, already decoded. `start..end` is where its text sits
    /// in the file, trimmed.
    Value {
        tag: String,
        text: String,
        row: u32,
        start: usize,
        end: usize,
    },
    /// `<TAG>` followed directly by another tag: an aggregate opening (or an empty value).
    Open {
        tag: String,
        row: u32,
    },
    Close {
        tag: String,
    },
}

const CDATA_OPEN: &str = "<![CDATA[";
const COMMENT_OPEN: &str = "<!--";

/// How many bytes of `s` (which starts with `<`) a comment or a CDATA section takes, up to and
/// including its end marker, or `None` if it's neither. One left open runs to the end.
fn markup_len(s: &str) -> Option<usize> {
    let (open, close) = if s.starts_with(COMMENT_OPEN) {
        (COMMENT_OPEN, "-->")
    } else if s.starts_with(CDATA_OPEN) {
        (CDATA_OPEN, "]]>")
    } else {
        return None;
    };
    let body = &s[open.len()..];
    Some(open.len() + body.find(close).map_or(body.len(), |i| i + close.len()))
}

/// The value after an opening tag: text up to the next tag, decoded, with CDATA sections read
/// as literal text and comments dropped. Returns the value, trimmed, and the bytes it used.
fn read_value(s: &str) -> (String, usize) {
    let mut out = String::new();
    let mut pos = 0;
    loop {
        let end = s[pos..].find('<').map_or(s.len(), |i| pos + i);
        out.push_str(&unescape(&s[pos..end]));
        pos = end;
        let rest = &s[pos..];
        let Some(len) = markup_len(rest) else { break };
        if let Some(body) = rest.strip_prefix(CDATA_OPEN) {
            let body = &body[..body.find("]]>").unwrap_or(body.len())];
            out.push_str(body);
        }
        pos += len;
    }
    (out.trim().to_owned(), pos)
}

fn tokens(text: &str) -> Vec<Token> {
    let start = find_root(text).unwrap_or(0);
    let mut row = 1 + count_newlines(&text[..start]);
    let mut rest = &text[start..];
    let mut out = Vec::new();
    while let Some(lt) = rest.find('<') {
        row += count_newlines(&rest[..lt]);
        rest = &rest[lt..];
        if let Some(len) = markup_len(rest) {
            // A comment or CDATA between tags, which may itself hold `<` or `>`.
            row += count_newlines(&rest[..len]);
            rest = &rest[len..];
            continue;
        }
        rest = &rest[1..];
        let Some(gt) = rest.find('>') else { break };
        let inner = rest[..gt].trim();
        row += count_newlines(&rest[..gt]);
        rest = &rest[gt + 1..];
        if inner.starts_with('?') || inner.starts_with('!') || inner.ends_with('/') {
            continue; // processing instructions, comments, empty elements
        }
        if let Some(tag) = inner.strip_prefix('/') {
            out.push(Token::Close {
                tag: tag.trim().to_ascii_uppercase(),
            });
            continue;
        }
        let tag = inner
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let (value, used) = read_value(rest);
        if value.is_empty() {
            out.push(Token::Open { tag, row });
        } else {
            let raw = &rest[..used];
            let start = text.len() - rest.len() + (raw.len() - raw.trim_start().len());
            out.push(Token::Value {
                tag,
                text: value,
                row,
                start,
                end: start + raw.trim().len(),
            });
        }
        row += count_newlines(&rest[..used]);
        rest = &rest[used..];
    }
    out
}

fn count_newlines(s: &str) -> u32 {
    u32::try_from(s.bytes().filter(|&b| b == b'\n').count()).unwrap_or(u32::MAX)
}

/// Decodes the five XML entities and numeric character references (`&#201;`, `&#xC9;`) in one
/// pass. Anything else that starts with `&` is left as written: a bare `&` (common in SGML
/// files), an unknown name, or a reference that is malformed or names no allowed character.
///
/// Entity names are case-sensitive, as in XML, so `&AMP;` stays as it is. The `x` of a hex
/// reference may be either case, since `&#X41;` can't mean anything else.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        // The longest reference we decode is `&#x10FFFF;` or `&#1114111;`; allow a few leading
        // zeros. Past that, a `;` belongs to something else.
        let decoded = rest[1..]
            .find(';')
            .filter(|&semi| semi <= 14)
            .and_then(|semi| Some((entity(&rest[1..=semi])?, semi + 2)));
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The character `name` (the text between `&` and `;`) stands for, if we decode it.
fn entity(name: &str) -> Option<char> {
    let code = match name {
        "lt" => return Some('<'),
        "gt" => return Some('>'),
        "quot" => return Some('"'),
        "apos" => return Some('\''),
        "amp" => return Some('&'),
        _ => name.strip_prefix('#')?,
    };
    let (digits, radix) = match code.strip_prefix(['x', 'X']) {
        Some(hex) => (hex, 16),
        None => (code, 10),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    let c = char::from_u32(u32::from_str_radix(digits, radix).ok()?)?;
    // XML allows no control characters other than tab and the line breaks.
    (!c.is_control() || matches!(c, '\t' | '\n' | '\r')).then_some(c)
}

/// `YYYYMMDD`, optionally followed by a time and timezone, which are ignored: the bank's posting
/// date is the date as written.
fn parse_date(raw: &str) -> Option<NaiveDate> {
    let digits = raw.get(..8)?;
    NaiveDate::parse_from_str(digits, "%Y%m%d").ok()
}

/// A `STATUS` aggregate: `CODE` 0 is success; `SEVERITY` is `INFO`, `WARN` or `ERROR`.
#[derive(Default)]
struct Status {
    row: u32,
    /// In the sign-on response, rather than a statement's.
    signon: bool,
    code: Option<String>,
    severity: Option<String>,
    message: Option<String>,
}

impl Status {
    fn is_error(&self) -> bool {
        self.severity
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("ERROR"))
    }

    fn is_not_success(&self) -> bool {
        self.is_error()
            || self
                .code
                .as_deref()
                .is_some_and(|c| !c.trim().trim_start_matches('0').is_empty())
    }

    fn into_problem(self) -> Problem {
        Problem::BankError {
            row: self.row,
            bank_code: self.code.unwrap_or_default(),
            message: self.message,
        }
    }
}

/// Message sets that hold a bank or card statement, or nothing (sign-on). Any other `…MSGSRSV1`
/// (investments, bill pay, sign-up) holds something we don't read.
const READ_MESSAGE_SETS: &[&str] = &["SIGNONMSGSRSV1", "BANKMSGSRSV1", "CREDITCARDMSGSRSV1"];

/// Whether `tag` is an aggregate we track. Text straight after one (a CDATA section, say) doesn't
/// turn it into a value: it still opens.
fn is_aggregate(tag: &str) -> bool {
    tag.ends_with("MSGSRSV1")
        || matches!(
            tag,
            "SONRS"
                | "STATUS"
                | "STMTTRNRS"
                | "CCSTMTTRNRS"
                | "STMTRS"
                | "CCSTMTRS"
                | "BANKACCTFROM"
                | "CCACCTFROM"
                | "BANKTRANLIST"
                | "STMTTRN"
                | "LEDGERBAL"
                | "PAYEE"
        )
}

#[derive(Default)]
struct Txn {
    row: u32,
    date: Option<(String, u32)>,
    amount: Option<(String, u32)>,
    name: Option<String>,
    payee_name: Option<String>,
    memo: Option<String>,
    fitid: Option<String>,
}

pub fn parse(text: &str) -> Result<Statement, Vec<Problem>> {
    let mut problems = Vec::new();
    let mut statements = 0;
    let mut kind = StatementKind::Bank;
    let mut account = None;
    let mut currency = None;
    let mut period_start = None;
    let mut period_end = None;
    let mut closing_amount = None;
    let mut closing_date = None;
    let mut closing_span: Option<SourceSpan> = None;
    let line_starts = LineStarts::new(text);
    let mut lines = Vec::new();

    let mut in_acct = false;
    let mut in_ledgerbal = false;
    let mut in_payee = false;
    let mut txn: Option<Txn> = None;
    let mut root_closed = false;
    let mut last_complete: Option<(u32, Option<NaiveDate>)> = None;
    let mut in_signon = false;
    let mut status: Option<Status> = None;
    let mut statuses: Vec<Status> = Vec::new();
    let mut other_section: Option<(u32, String)> = None;

    let date_value = |raw: &str, row: u32, problems: &mut Vec<Problem>| {
        let d = parse_date(raw);
        if d.is_none() {
            problems.push(Problem::BadDate {
                row,
                value: raw.to_owned(),
            });
        }
        d
    };

    for token in tokens(text) {
        let token = match token {
            Token::Value { tag, row, .. } if is_aggregate(&tag) => Token::Open { tag, row },
            t => t,
        };
        match token {
            Token::Open { tag, row } => match tag.as_str() {
                "STMTRS" => {
                    statements += 1;
                    kind = StatementKind::Bank;
                }
                "CCSTMTRS" => {
                    statements += 1;
                    kind = StatementKind::CreditCard;
                }
                "BANKACCTFROM" | "CCACCTFROM" => in_acct = true,
                "LEDGERBAL" => in_ledgerbal = true,
                "PAYEE" => in_payee = true,
                "STMTTRN" => {
                    txn = Some(Txn {
                        row,
                        ..Txn::default()
                    });
                }
                "SONRS" => in_signon = true,
                "STATUS" => {
                    status = Some(Status {
                        row,
                        signon: in_signon,
                        ..Status::default()
                    });
                }
                t if t.ends_with("MSGSRSV1")
                    && !READ_MESSAGE_SETS.contains(&t)
                    && other_section.is_none() =>
                {
                    other_section = Some((row, tag));
                }
                _ => {}
            },
            Token::Close { tag } => match tag.as_str() {
                "BANKACCTFROM" | "CCACCTFROM" => in_acct = false,
                "LEDGERBAL" => in_ledgerbal = false,
                "PAYEE" => in_payee = false,
                "SONRS" => in_signon = false,
                "STATUS" => statuses.extend(status.take()),
                "STMTTRN" => {
                    if let Some(t) = txn.take() {
                        let date = t.date.as_ref().and_then(|(raw, _)| parse_date(raw));
                        last_complete = Some((t.row, date));
                        lines.extend(finish(t, &mut problems));
                    }
                }
                "OFX" => {
                    root_closed = true;
                    break;
                }
                _ => {}
            },
            Token::Value {
                tag,
                text: value,
                row,
                start,
                end,
            } => {
                if let Some(s) = status.as_mut() {
                    match tag.as_str() {
                        "CODE" => s.code = Some(value),
                        "SEVERITY" => s.severity = Some(value),
                        "MESSAGE" => s.message = Some(value),
                        _ => {}
                    }
                    continue;
                }
                if let Some(t) = txn.as_mut() {
                    match tag.as_str() {
                        "DTPOSTED" => t.date = Some((value, row)),
                        "TRNAMT" => t.amount = Some((value, row)),
                        "NAME" if in_payee => t.payee_name = Some(value),
                        "NAME" => t.name = Some(value),
                        "MEMO" => t.memo = Some(value),
                        "FITID" => t.fitid = Some(value),
                        _ => {}
                    }
                    continue;
                }
                match tag.as_str() {
                    "CURDEF" => currency = Some(value),
                    "ACCTID" if in_acct => account = Some(value),
                    "DTSTART" => period_start = date_value(&value, row, &mut problems),
                    "DTEND" => period_end = date_value(&value, row, &mut problems),
                    "BALAMT" if in_ledgerbal => match parse_amount(&value) {
                        Ok(m) => {
                            closing_amount = Some(m);
                            closing_span = Some(line_starts.span(text, start, end));
                        }
                        Err(message) => problems.push(Problem::BadAmount {
                            row,
                            value,
                            message,
                        }),
                    },
                    "DTASOF" if in_ledgerbal => {
                        closing_date = date_value(&value, row, &mut problems);
                    }
                    _ => {}
                }
            }
        }
    }
    // SGML may leave leaf tags open, but aggregates are always closed. A file that ends before
    // `</OFX>`, or inside a transaction, was cut off: its last line may be half-read (`-7.0` for
    // `-7.05`) and its closing balance missing, so none of it is used.
    if !root_closed || txn.is_some() {
        return Err(vec![Problem::Truncated {
            row: 1 + count_newlines(text.trim_end()),
            last_complete_row: last_complete.map(|(row, _)| row),
            last_complete_date: last_complete.and_then(|(_, date)| date),
        }]);
    }

    // The bank refused: a failed sign-on means nothing after it can be trusted, and a statement
    // that isn't there may say why in its own status. A warning beside a statement is read as usual.
    let refused = statuses
        .iter()
        .position(|s| s.signon && s.is_error())
        .or_else(|| (statements == 0).then(|| statuses.iter().position(Status::is_not_success))?);
    if let Some(i) = refused {
        return Err(vec![statuses.swap_remove(i).into_problem()]);
    }
    if statements == 0 {
        return Err(vec![match other_section {
            Some((row, section)) => Problem::UnsupportedSection { row, section },
            None => Problem::NoStatement,
        }]);
    }

    if statements > 1 {
        problems.push(Problem::SeveralStatements);
    }
    if let Some(c) = currency.filter(|c| !c.eq_ignore_ascii_case("NZD")) {
        problems.push(Problem::ForeignCurrency { currency: c });
    }
    if account.is_none() {
        problems.push(Problem::Missing {
            field: "ACCTID".to_owned(),
        });
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    // Some card files put a bank-style account id in `ACCTID`; anything card-like is masked.
    let account = account.map(|raw| match kind {
        StatementKind::CreditCard => {
            normalise_card(&raw).unwrap_or_else(|| normalise_account(&raw))
        }
        StatementKind::Bank => normalise_account(&raw),
    });
    let closing = match (closing_amount, closing_date.or(period_end)) {
        (Some(amount), Some(date)) => Some(Balance {
            date,
            amount,
            span: closing_span,
        }),
        _ => None,
    };
    Ok(Statement {
        parser: String::new(),
        kind,
        account,
        period_start,
        period_end,
        opening: None,
        closing,
        lines,
    })
}

fn finish(t: Txn, problems: &mut Vec<Problem>) -> Option<StatementLine> {
    let missing = |field: &str| Problem::MissingField {
        row: t.row,
        field: field.to_owned(),
    };
    let Some((raw_date, date_row)) = &t.date else {
        problems.push(missing("DTPOSTED"));
        return None;
    };
    let Some((raw_amount, amount_row)) = &t.amount else {
        problems.push(missing("TRNAMT"));
        return None;
    };
    let date = parse_date(raw_date);
    if date.is_none() {
        problems.push(Problem::BadDate {
            row: *date_row,
            value: raw_date.clone(),
        });
    }
    let amount = parse_amount(raw_amount)
        .map_err(|message| {
            problems.push(Problem::BadAmount {
                row: *amount_row,
                value: raw_amount.clone(),
                message,
            });
        })
        .ok();
    let name = t.name.as_deref().or(t.payee_name.as_deref()).unwrap_or("");
    Some(StatementLine {
        row: t.row,
        date: date?,
        amount: amount?,
        description: normalise_description([name, t.memo.as_deref().unwrap_or("")]),
        bank_id: t.fitid,
        balance: None,
        balance_span: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use acct_core::Money;

    const XML_FILE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>NZD</CURDEF>
    <BANKACCTFROM><BANKID>99</BANKID><ACCTID>991001000012300</ACCTID></BANKACCTFROM>
    <BANKTRANLIST>
      <DTSTART>20250801000000[+12:NZST]</DTSTART><DTEND>20250831</DTEND>
      <STMTTRN>
        <TRNTYPE>DEBIT</TRNTYPE>
        <DTPOSTED>20250804120000.000[+12:NZST]</DTPOSTED>
        <TRNAMT>-86.40</TRNAMT>
        <FITID>A1</FITID>
        <NAME>AMBER &amp; ASH</NAME>
        <MEMO>EFTPOS  auckland</MEMO>
      </STMTTRN>
      <STMTTRN>
        <DTPOSTED>20250805</DTPOSTED><TRNAMT>10</TRNAMT><FITID>A2</FITID>
        <PAYEE><NAME>Payee Name</NAME></PAYEE>
      </STMTTRN>
    </BANKTRANLIST>
    <LEDGERBAL><BALAMT>100.00</BALAMT><DTASOF>20250831</DTASOF></LEDGERBAL>
    <AVAILBAL><BALAMT>999.00</BALAMT><DTASOF>20250831</DTASOF></AVAILBAL>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
"#;

    #[test]
    fn reads_ofx_2_xml() {
        assert!(detect_xml(XML_FILE));
        assert!(!detect_sgml(XML_FILE));
        let s = parse(XML_FILE).unwrap();
        assert_eq!(s.account.as_deref(), Some("99-1001-0000123-00"));
        assert_eq!(s.period_start, Some("2025-08-01".parse().unwrap()));
        assert_eq!(s.lines.len(), 2);
        assert_eq!(s.lines[0].date, "2025-08-04".parse().unwrap());
        assert_eq!(s.lines[0].amount, Money::from_cents(-8640));
        assert_eq!(s.lines[0].description, "AMBER & ASH EFTPOS AUCKLAND");
        assert_eq!(s.lines[0].bank_id.as_deref(), Some("A1"));
        assert_eq!(s.lines[1].description, "PAYEE NAME");
        assert_eq!(s.closing.unwrap().amount, Money::from_cents(10_000));
    }

    const CARD_FILE: &str = "OFXHEADER:100\n\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>NZD
<CCACCTFROM><ACCTID>9999 0000 0000 4417</CCACCTFROM>
<BANKTRANLIST><DTSTART>20250801<DTEND>20250831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250802<TRNAMT>-48.90<FITID>C1<NAME>Shop</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20250811<TRNAMT>48.90<FITID>C2<NAME>Payment</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-12.00<DTASOF>20250831</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>
";

    #[test]
    fn the_closing_balance_knows_where_it_was_read() {
        let s = parse(XML_FILE).unwrap();
        let span = s.closing.unwrap().span.unwrap();
        let line = XML_FILE.lines().nth(span.line as usize - 1).unwrap();
        assert_eq!(&line[span.start as usize..span.end as usize], "100.00");
        assert!(line.contains("<LEDGERBAL>"), "not AVAILBAL's: {line}");
        // SGML leaves the value open to the end of its line.
        let s = parse(CARD_FILE).unwrap();
        let span = s.closing.unwrap().span.unwrap();
        let line = CARD_FILE.lines().nth(span.line as usize - 1).unwrap();
        assert_eq!(&line[span.start as usize..span.end as usize], "-12.00");
    }

    #[test]
    fn reads_a_card_statement_and_masks_the_card() {
        assert!(detect_sgml(CARD_FILE));
        let s = parse(CARD_FILE).unwrap();
        assert_eq!(s.kind, StatementKind::CreditCard);
        assert_eq!(s.account.as_deref(), Some("XXXX-XXXX-XXXX-4417"));
        assert_eq!(s.lines[0].amount, Money::from_cents(-4890), "a purchase");
        assert_eq!(s.lines[1].amount, Money::from_cents(4890), "a payment");
        assert_eq!(s.closing.unwrap().amount, Money::from_cents(-1200), "owed");
        assert_eq!(parse(XML_FILE).unwrap().kind, StatementKind::Bank);
    }

    #[test]
    fn a_bank_and_a_card_statement_in_one_file_are_refused() {
        let both = XML_FILE.replace(
            "</BANKMSGSRSV1>",
            "</BANKMSGSRSV1><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
             <CCACCTFROM><ACCTID>XXXXXXXXXXXX4417</ACCTID></CCACCTFROM>
             </CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>",
        );
        assert_eq!(parse(&both).unwrap_err(), vec![Problem::SeveralStatements]);
    }

    #[test]
    fn foreign_currency_is_refused() {
        let usd = XML_FILE.replace("<CURDEF>NZD", "<CURDEF>USD");
        assert!(
            parse(&usd)
                .unwrap_err()
                .contains(&Problem::ForeignCurrency {
                    currency: "USD".to_owned()
                })
        );
    }

    #[test]
    fn references_are_decoded_in_one_pass() {
        assert_eq!(
            unescape("&amp;lt; &#38;#65; &#x41;&#X42;&#67;"),
            "&lt; &#65; ABC"
        );
        // Left as written: unknown or upper-case names, bad digits, no `;`, out of range.
        for s in [
            "&AMP;", "&nbsp;", "&#;", "&#x;", "&#1f;", "&#65", "&#xD800;", "&#0;", "a & b",
        ] {
            assert_eq!(unescape(s), s);
        }
        // A `;` far away belongs to something else.
        assert_eq!(unescape("A & B, C & D; E"), "A & B, C & D; E");
        assert_eq!(unescape("é&amp;é"), "é&é");
    }

    #[test]
    fn a_comment_holding_a_bracket_does_not_end_early() {
        let file = XML_FILE.replace(
            "<CURDEF>",
            "<!-- <ACCTID>1 > 2 --><![CDATA[<ACCTID>3]]><CURDEF>",
        );
        let s = parse(&file).unwrap();
        assert_eq!(s.account.as_deref(), Some("99-1001-0000123-00"));
        assert_eq!(s.lines[0].row, 9, "rows still count the lines");
    }

    #[test]
    fn a_file_without_its_root_closed_is_truncated() {
        let cut = XML_FILE.replace("</OFX>", "");
        assert!(matches!(
            &parse(&cut).unwrap_err()[..],
            [Problem::Truncated {
                last_complete_row: Some(17),
                ..
            }]
        ));
    }

    const SIGNON_OK: &str = "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>\
                             </SONRS></SIGNONMSGSRSV1>";

    #[test]
    fn a_failed_sign_on_is_the_banks_error() {
        let signon = SIGNON_OK.replace("<CODE>0", "<CODE>15500").replace(
            "INFO</SEVERITY>",
            "ERROR</SEVERITY><MESSAGE> Signon &amp; invalid </MESSAGE>",
        );
        // Even with a statement after it, nothing from a failed sign-on is used.
        let file = XML_FILE.replace("<OFX>", &format!("<OFX>{signon}"));
        assert_eq!(
            parse(&file).unwrap_err(),
            [Problem::BankError {
                row: 3,
                bank_code: "15500".to_owned(),
                message: Some("Signon & invalid".to_owned()),
            }]
        );
    }

    #[test]
    fn a_statement_that_is_not_there_passes_on_its_status() {
        let missing = "OFXHEADER:100\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><TRNUID>1\n\
                       <STATUS><CODE>2003<SEVERITY>ERROR</STATUS>\n\
                       </STMTTRNRS></BANKMSGSRSV1></OFX>\n";
        assert_eq!(
            parse(missing).unwrap_err(),
            [Problem::BankError {
                row: 5,
                bank_code: "2003".to_owned(),
                message: None,
            }]
        );
    }

    #[test]
    fn a_warning_beside_a_statement_is_read_as_usual() {
        let warn = SIGNON_OK
            .replace("<CODE>0", "<CODE>15000")
            .replace("INFO", "WARN");
        let file = XML_FILE.replace("<OFX>", &format!("<OFX>{warn}"));
        assert_eq!(parse(&file).unwrap().lines.len(), 2);
    }

    #[test]
    fn a_file_with_no_statement_says_so() {
        let empty = format!("<?xml version=\"1.0\"?><OFX>{SIGNON_OK}</OFX>");
        assert_eq!(parse(&empty).unwrap_err(), [Problem::NoStatement]);
        let bills =
            format!("OFXHEADER:100\n\n<OFX>{SIGNON_OK}\n<BILLPAYMSGSRSV1></BILLPAYMSGSRSV1></OFX>");
        assert_eq!(
            parse(&bills).unwrap_err(),
            [Problem::UnsupportedSection {
                row: 4,
                section: "BILLPAYMSGSRSV1".to_owned(),
            }]
        );
    }

    #[test]
    fn bad_values_are_reported_with_their_row() {
        let bad = XML_FILE.replace("<TRNAMT>-86.40<", "<TRNAMT>-86.4x<");
        let problems = parse(&bad).unwrap_err();
        assert!(
            matches!(&problems[..], [Problem::BadAmount { row: 12, .. }]),
            "{problems:?}"
        );
    }
}
