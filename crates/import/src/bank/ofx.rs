//! OFX: 1.x in SGML (leaf tags left unclosed) and 2.x in XML.
//!
//! Both are read by one tokenizer that treats `<TAG>text` as a value and `<TAG>` followed by
//! another tag as an aggregate opening, so closing tags are optional. One statement for one NZD
//! account is read: a bank statement (`STMTRS` in `BANKMSGSRSV1`, account in `BANKACCTFROM`) or a
//! credit card statement (`CCSTMTRS` in `CREDITCARDMSGSRSV1`, card in `CCACCTFROM`). A card's
//! `ACCTID` is masked to its last four digits (see [`normalise_card`]). The description is `NAME`
//! then `MEMO`. OFX has no opening balance; `LEDGERBAL` gives the closing balance.
//!
//! OFX already signs card amounts from the account holder's point of view (a purchase is a
//! negative `TRNAMT`, a payment a positive one, and an amount owed a negative `BALAMT`), which is
//! our convention, so nothing is flipped.

use chrono::NaiveDate;

use super::text::{normalise_account, normalise_card, normalise_description, parse_amount};
use super::{Balance, ParserInfo, Problem, Statement, StatementKind, StatementLine};

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

/// OFX 2: an XML declaration and an `OFX` processing instruction or root.
pub fn detect_xml(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with("<?xml") && (head.contains("<?OFX") || head.contains("<OFX>"))
}

/// OFX 1: the `OFXHEADER:` header block, or a bare `<OFX>` root without closed leaf tags.
pub fn detect_sgml(text: &str) -> bool {
    let head = text.trim_start();
    if head.starts_with("OFXHEADER:") {
        return head.contains("<OFX>");
    }
    head.starts_with("<OFX>")
}

enum Token<'a> {
    /// `<TAG>` followed by text: a value.
    Value {
        tag: String,
        text: &'a str,
        row: u32,
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

fn tokens(text: &str) -> Vec<Token<'_>> {
    let start = text.find("<OFX>").unwrap_or(0);
    let mut row = 1 + count_newlines(&text[..start]);
    let mut rest = &text[start..];
    let mut out = Vec::new();
    while let Some(lt) = rest.find('<') {
        row += count_newlines(&rest[..lt]);
        rest = &rest[lt + 1..];
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
        let end = rest.find('<').unwrap_or(rest.len());
        let value = rest[..end].trim();
        if value.is_empty() {
            out.push(Token::Open { tag, row });
        } else {
            out.push(Token::Value {
                tag,
                text: value,
                row,
            });
        }
    }
    out
}

fn count_newlines(s: &str) -> u32 {
    u32::try_from(s.bytes().filter(|&b| b == b'\n').count()).unwrap_or(u32::MAX)
}

/// Decodes the five XML entities; a bare `&` (common in SGML files) is left alone.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// `YYYYMMDD`, optionally followed by a time and timezone, which are ignored: the bank's posting
/// date is the date as written.
fn parse_date(raw: &str) -> Option<NaiveDate> {
    let digits = raw.get(..8)?;
    NaiveDate::parse_from_str(digits, "%Y%m%d").ok()
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
    let mut lines = Vec::new();

    let mut in_acct = false;
    let mut in_ledgerbal = false;
    let mut in_payee = false;
    let mut txn: Option<Txn> = None;

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
                _ => {}
            },
            Token::Close { tag } => match tag.as_str() {
                "BANKACCTFROM" | "CCACCTFROM" => in_acct = false,
                "LEDGERBAL" => in_ledgerbal = false,
                "PAYEE" => in_payee = false,
                "STMTTRN" => {
                    if let Some(t) = txn.take() {
                        lines.extend(finish(t, &mut problems));
                    }
                }
                _ => {}
            },
            Token::Value { tag, text, row } => {
                let value = unescape(text);
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
                        Ok(m) => closing_amount = Some(m),
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
    // An SGML file may leave the last STMTTRN unclosed if it's truncated; keep what was read.
    if let Some(t) = txn.take() {
        lines.extend(finish(t, &mut problems));
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
        (Some(amount), Some(date)) => Some(Balance { date, amount }),
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
    fn bad_values_are_reported_with_their_row() {
        let bad = XML_FILE.replace("<TRNAMT>-86.40<", "<TRNAMT>-86.4x<");
        let problems = parse(&bad).unwrap_err();
        assert!(
            matches!(&problems[..], [Problem::BadAmount { row: 12, .. }]),
            "{problems:?}"
        );
    }
}
