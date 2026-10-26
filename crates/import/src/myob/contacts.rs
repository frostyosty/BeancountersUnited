//! Contacts: AccountRight's cards exports and MYOB Business's contacts report.
//!
//! AccountRight exports customer, supplier and personal cards as separate files with different
//! fields, so the header says which kind they are: customer cards have customer-only fields
//! such as `% Monthly Charge` or `Receipt Memo`, supplier cards have `Cost Per Hour` or
//! `Payment Memo`, and personal cards have neither. MYOB Business's report has a
//! `Contact type` on each row.
//!
//! A card's name is `Co./Last Name`, with `First Name` in front for an individual.

use super::fields::{self, bad_row};
use super::{cell, Table};
use crate::history::{ContactKind, HistoryContact, HistoryError};

const CUSTOMER_FIELDS: &[&str] = &[
    "% monthly charge",
    "receipt memo",
    "salesperson",
    "use customer's gst code",
    "use customer's tax code",
    "price level",
];

const SUPPLIER_FIELDS: &[&str] = &[
    "cost per hour",
    "payment memo",
    "use supplier's gst code",
    "use supplier's tax code",
    "particulars (nz only)",
];

pub(super) fn parse(table: &Table) -> Result<Vec<HistoryContact>, Vec<HistoryError>> {
    let last_col = table.col(&["co./last name", "contact name", "name", "company name"]);
    let first_col = table.col(&["first name"]);
    let type_col = table.col(&["contact type", "card type", "type"]);
    let gst_col = table.col(&[
        "gst id no.",
        "gst id no",
        "tax id no.",
        "gst number",
        "gst no.",
        "tax id",
    ]);
    let email_col = table.col(&["email", "addr 1 - email", "email address"]);
    let phone_col = table.col(&["phone no. 1", "addr 1 - phone no. 1", "phone", "phone number"]);

    let file_kind = if CUSTOMER_FIELDS.iter().any(|f| table.has(f)) {
        ContactKind::Customer
    } else if SUPPLIER_FIELDS.iter().any(|f| table.has(f)) {
        ContactKind::Supplier
    } else {
        ContactKind::Other
    };

    let mut contacts = Vec::new();
    let mut errors = Vec::new();
    for (row, cells) in &table.rows {
        let row = *row;
        let last = cell(cells, last_col);
        if last.is_empty() {
            errors.push(bad_row(row, "Co./Last Name", last, "the name is blank"));
            continue;
        }
        let first = cell(cells, first_col);
        let name = if first.is_empty() {
            last.to_owned()
        } else {
            format!("{first} {last}")
        };
        let kind = match type_col {
            Some(_) => {
                let raw = cell(cells, type_col);
                match row_kind(raw) {
                    Some(kind) => kind,
                    None => {
                        errors.push(bad_row(
                            row,
                            "Contact type",
                            raw,
                            "expected Customer, Supplier, Personal or Other",
                        ));
                        continue;
                    }
                }
            }
            None => file_kind,
        };
        let optional = |col| Some(cell(cells, col).to_owned()).filter(|s| !s.is_empty());
        contacts.push(HistoryContact {
            row,
            name,
            kind,
            gst_number: optional(gst_col),
            email: optional(email_col),
            phone: optional(phone_col),
        });
    }
    if errors.is_empty() {
        Ok(contacts)
    } else {
        Err(errors)
    }
}

fn row_kind(raw: &str) -> Option<ContactKind> {
    let t = fields::column_name(raw);
    let customer = t.contains("customer");
    let supplier = t.contains("supplier");
    Some(match (customer, supplier) {
        (true, true) => ContactKind::Both,
        (true, false) => ContactKind::Customer,
        (false, true) => ContactKind::Supplier,
        _ if ["personal", "other", "employee", "lead"].contains(&t.as_str()) => ContactKind::Other,
        _ => return None,
    })
}
