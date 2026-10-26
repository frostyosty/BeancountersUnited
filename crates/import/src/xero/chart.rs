//! Chart of accounts: Accounting › Chart of accounts › Export. A plain CSV:
//! `*Code, *Name, *Type, *Tax Code, Description, Dashboard, Expense Claims, Enable Payments,
//! Balance`. We read code, name, type, tax code and, where present, status; the rest is ignored.

use crate::history::{HistoryAccount, HistoryError, SourceAccountType};

use super::text::{Header, Record, bad_row, key};

const CODE: &[&str] = &["code", "accountcode"];
const NAME: &[&str] = &["name", "accountname"];
const TYPE: &[&str] = &["type", "accounttype"];
const TAX: &[&str] = &["taxcode", "taxrate", "taxtype"];
const STATUS: &[&str] = &["status"];

pub fn detect(records: &[Record]) -> bool {
    records.first().is_some_and(|r| {
        let h = Header::new(r);
        h.has(CODE) && h.has(NAME) && h.has(TYPE) && h.has(TAX)
    })
}

/// Xero's account types, by display name or API code, collapsed onto ours.
fn account_type(raw: &str) -> Option<SourceAccountType> {
    use SourceAccountType::*;
    Some(match key(raw).as_str() {
        "bank" | "currentasset" | "current" | "fixedasset" | "fixed" | "inventory"
        | "noncurrentasset" | "noncurrent" | "prepayment" => Asset,
        "currentliability" | "currliab" | "liability" | "noncurrentliability" | "termliab"
        | "paygliability" | "payg" => Liability,
        "equity" => Equity,
        "revenue" | "sales" => Income,
        "otherincome" => OtherIncome,
        "directcosts" => CostOfSales,
        "expense" | "overhead" | "overheads" | "depreciation" | "depreciatn" => Expense,
        _ => return None,
    })
}

pub fn parse(records: &[Record]) -> Result<Vec<HistoryAccount>, Vec<HistoryError>> {
    let header = Header::new(&records[0]);
    let col = |names| header.find(names).unwrap_or(usize::MAX);
    let (code, name, kind, tax) = (col(CODE), col(NAME), col(TYPE), col(TAX));
    let status = header.find(STATUS);

    let mut accounts: Vec<HistoryAccount> = Vec::new();
    let mut errors = Vec::new();
    for r in &records[1..] {
        let c = r.get(code);
        if c.is_empty() {
            errors.push(bad_row(
                r.row,
                &header.name(code),
                c,
                "the account has no code; give it one in Xero and export again",
            ));
            continue;
        }
        if let Some(first) = accounts.iter().find(|a| a.code == c) {
            errors.push(bad_row(
                r.row,
                &header.name(code),
                c,
                format!("code already used on row {}", first.row),
            ));
            continue;
        }
        let Some(account_type) = account_type(r.get(kind)) else {
            errors.push(bad_row(
                r.row,
                &header.name(kind),
                r.get(kind),
                "not a Xero account type",
            ));
            continue;
        };
        let tax_code = Some(r.get(tax))
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
        accounts.push(HistoryAccount {
            row: r.row,
            code: c.to_owned(),
            name: r.get(name).to_owned(),
            account_type,
            source_type: r.get(kind).to_owned(),
            tax_code,
            is_header: false,
            active: status.is_none_or(|s| !r.get(s).eq_ignore_ascii_case("archived")),
        });
    }
    if accounts.is_empty() && errors.is_empty() {
        errors.push(HistoryError::Empty);
    }
    if errors.is_empty() {
        Ok(accounts)
    } else {
        Err(errors)
    }
}
