//! Contacts: Contacts › All contacts › Export. A plain CSV whose columns match Xero's contact
//! import template (`ContactName`, `EmailAddress`, `PhoneNumber`, `TaxNumber`, address columns,
//! default accounts and so on). We read the name, email, phone and GST number.
//!
//! The export has no customer or supplier flag, so the kind is inferred from the contact's
//! defaults: a sales account or sales tax default makes it a customer, a purchases account or
//! purchases tax default a supplier, both makes it both, and neither leaves it `Other`.

use crate::history::{ContactKind, HistoryContact, HistoryError};

use super::text::{Header, Record, bad_row};

const NAME: &[&str] = &["contactname"];

pub fn detect(records: &[Record]) -> bool {
    records.first().is_some_and(|r| Header::new(r).has(NAME))
}

pub fn parse(records: &[Record]) -> Result<Vec<HistoryContact>, Vec<HistoryError>> {
    let header = Header::new(&records[0]);
    let name = header.find(NAME).unwrap_or(usize::MAX);
    let cell = |r: &Record, names: &[&str]| -> Option<String> {
        names
            .iter()
            .filter_map(|n| header.find(&[n]))
            .map(|i| r.get(i))
            .find(|v| !v.is_empty())
            .map(str::to_owned)
    };

    let mut contacts: Vec<HistoryContact> = Vec::new();
    let mut errors = Vec::new();
    for r in &records[1..] {
        let n = r.get(name);
        if n.is_empty() {
            errors.push(bad_row(
                r.row,
                &header.name(name),
                n,
                "the contact has no name",
            ));
            continue;
        }
        if let Some(first) = contacts.iter().find(|c| c.name.eq_ignore_ascii_case(n)) {
            errors.push(bad_row(
                r.row,
                &header.name(name),
                n,
                format!("the same contact is on row {}", first.row),
            ));
            continue;
        }
        let sells = cell(r, &["salesaccount", "accountsreceivabletaxcodename"]).is_some();
        let buys = cell(r, &["purchasesaccount", "accountspayabletaxcodename"]).is_some();
        let kind = match (sells, buys) {
            (true, true) => ContactKind::Both,
            (true, false) => ContactKind::Customer,
            (false, true) => ContactKind::Supplier,
            (false, false) => ContactKind::Other,
        };
        contacts.push(HistoryContact {
            row: r.row,
            name: n.to_owned(),
            kind,
            gst_number: cell(r, &["taxnumber"]),
            email: cell(r, &["emailaddress", "email"]),
            phone: cell(r, &["phonenumber", "mobilenumber", "ddinumber"]),
        });
    }
    if contacts.is_empty() && errors.is_empty() {
        errors.push(HistoryError::Empty);
    }
    if errors.is_empty() {
        Ok(contacts)
    } else {
        Err(errors)
    }
}
