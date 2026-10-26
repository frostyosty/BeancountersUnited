use acct_core::Money;
use chrono::NaiveDate;

use super::text::{amount, date, split_account};
use super::{XeroExport, detect, parse};
use crate::history::{
    ContactKind, HistoryError, HistoryFile, HistoryGl, HistorySource, HistoryTb, SourceAccountType,
    gl_differences,
};

const CHART: &str = include_str!("../../../../fixtures/xero/chart-of-accounts.csv");
const CONTACTS: &str = include_str!("../../../../fixtures/xero/contacts.csv");
const TB_2025: &str = include_str!("../../../../fixtures/xero/trial-balance-2025.csv");
const TB_2026: &str = include_str!("../../../../fixtures/xero/trial-balance-2026.csv");
const GL_2025: &str = include_str!("../../../../fixtures/xero/account-transactions-2025.csv");
const GL_2026: &str = include_str!("../../../../fixtures/xero/account-transactions-2026.csv");

fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn file(text: &str) -> HistoryFile {
    let import = parse(text).unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(import.source, HistorySource::Xero);
    import.file
}

fn tb(text: &str) -> HistoryTb {
    match file(text) {
        HistoryFile::Tb(tb) => tb,
        other => panic!("not a TB: {other:?}"),
    }
}

fn gl(text: &str) -> HistoryGl {
    match file(text) {
        HistoryFile::Gl(gl) => gl,
        other => panic!("not a GL: {other:?}"),
    }
}

fn balance(tb: &HistoryTb, code: &str) -> i64 {
    tb.rows
        .iter()
        .find(|r| r.code == code)
        .map_or(0, |r| r.balance.cents())
}

fn errors(text: &str) -> Vec<HistoryError> {
    parse(text).unwrap_err()
}

#[test]
fn each_export_is_detected_by_inspection() {
    assert_eq!(detect(CHART), Some(XeroExport::ChartOfAccounts));
    assert_eq!(detect(CONTACTS), Some(XeroExport::Contacts));
    assert_eq!(detect(TB_2025), Some(XeroExport::TrialBalance));
    assert_eq!(detect(TB_2026), Some(XeroExport::TrialBalance));
    assert_eq!(detect(GL_2025), Some(XeroExport::AccountTransactions));
    assert_eq!(detect(GL_2026), Some(XeroExport::AccountTransactions));
    assert_eq!(detect("Date,Amount,Payee\n01/04/2025,10.00,X\n"), None);
    assert_eq!(detect(""), None);
}

#[test]
fn unknown_and_empty_files_are_rejected() {
    assert_eq!(
        errors("acct,dollars\n600,10\n"),
        [HistoryError::UnknownFormat {
            header: vec!["acct".into(), "dollars".into()]
        }]
    );
    assert_eq!(errors("\u{feff}\n,,\n"), [HistoryError::Empty]);
    assert_eq!(
        errors("*Code,*Name,*Type,*Tax Code\n"),
        [HistoryError::Empty]
    );
}

#[test]
fn the_chart_reads_codes_types_and_tax_defaults() {
    let HistoryFile::Chart(accounts) = file(CHART) else {
        panic!("not a chart")
    };
    assert_eq!(accounts.len(), 20);
    let get = |code: &str| accounts.iter().find(|a| a.code == code).unwrap();
    assert_eq!(get("090").account_type, SourceAccountType::Asset);
    assert_eq!(get("090").source_type, "Bank");
    assert_eq!(get("090").tax_code.as_deref(), Some("No GST"));
    assert_eq!(get("820").account_type, SourceAccountType::Liability);
    assert_eq!(get("960").account_type, SourceAccountType::Equity);
    assert_eq!(get("200").account_type, SourceAccountType::Income);
    assert_eq!(get("200").tax_code.as_deref(), Some("15% GST on Income"));
    assert_eq!(get("270").account_type, SourceAccountType::OtherIncome);
    assert_eq!(get("310").account_type, SourceAccountType::CostOfSales);
    assert_eq!(get("416").account_type, SourceAccountType::Expense);
    assert_eq!(get("469").account_type, SourceAccountType::Expense);
    assert_eq!(
        get("711").name,
        "Accumulated Depreciation - Kilns and Equipment"
    );
    assert!(accounts.iter().all(|a| a.active && !a.is_header));
    assert_eq!(get("090").row, 2);
    assert_eq!(get("491").row, 21);
}

#[test]
fn rows_are_numbered_the_same_for_crlf_and_lf() {
    let rows = |text: &str| match file(text) {
        HistoryFile::Chart(accounts) => accounts.iter().map(|a| a.row).collect::<Vec<_>>(),
        _ => panic!("not a chart"),
    };
    let lf = CHART.replace("\r\n", "\n");
    assert_eq!(rows(CHART), rows(&lf));
    assert_eq!(
        rows("\u{feff}Code,Name,Type,Tax Code\n\n\n001,Cash,Bank,No GST\n")[0],
        4
    );
}

#[test]
fn the_chart_accepts_api_type_codes_and_archived_status() {
    let csv = "Code,Name,Type,TaxType,Status\n\
               001,Cash,BANK,NONE,ACTIVE\n\
               002,Old,DEPRECIATN,NONE,ARCHIVED\n\
               003,Loan,TERMLIAB,,ACTIVE\n";
    let HistoryFile::Chart(accounts) = file(csv) else {
        panic!("not a chart")
    };
    assert_eq!(accounts[0].account_type, SourceAccountType::Asset);
    assert_eq!(accounts[1].account_type, SourceAccountType::Expense);
    assert!(!accounts[1].active);
    assert_eq!(accounts[2].account_type, SourceAccountType::Liability);
    assert_eq!(accounts[2].tax_code, None);
}

#[test]
fn chart_row_problems_carry_the_row_and_reason() {
    let csv = "*Code,*Name,*Type,*Tax Code\n\
               200,Sales,Revenue,15% GST on Income\n\
               ,Bank,Bank,No GST\n\
               200,Sales again,Revenue,15% GST on Income\n\
               300,Odd,Wages Payable,No GST\n";
    let errors = errors(csv);
    assert_eq!(errors.len(), 3, "{errors:?}");
    assert!(matches!(&errors[0], HistoryError::BadRow { row: 3, column, .. } if column == "*Code"));
    assert!(
        matches!(&errors[1], HistoryError::BadRow { row: 4, reason, .. } if reason.contains("row 2"))
    );
    assert!(
        matches!(&errors[2], HistoryError::BadRow { row: 5, column, value, .. } if column == "*Type" && value == "Wages Payable")
    );
}

#[test]
fn contacts_read_details_and_infer_their_kind() {
    let HistoryFile::Contacts(contacts) = file(CONTACTS) else {
        panic!("not contacts")
    };
    let get = |name: &str| contacts.iter().find(|c| c.name == name).unwrap();
    assert_eq!(contacts.len(), 6);
    assert_eq!(get("Harbourside Gift Co").kind, ContactKind::Customer);
    assert_eq!(
        get("Harbourside Gift Co").email.as_deref(),
        Some("orders@harbourside.example")
    );
    assert_eq!(get("Clayworks Supply Ltd").kind, ContactKind::Supplier);
    assert_eq!(
        get("Clayworks Supply Ltd").gst_number.as_deref(),
        Some("123-456-789")
    );
    assert_eq!(
        get("Clayworks Supply Ltd").phone.as_deref(),
        Some("09 555 0103")
    );
    assert_eq!(get("Ruru Hall Committee").kind, ContactKind::Both);
    assert_eq!(get("Inland Revenue").kind, ContactKind::Other);
    assert_eq!(get("Inland Revenue").email, None);
}

#[test]
fn contacts_need_a_name_and_no_repeats() {
    let csv = "*ContactName,EmailAddress\nA,a@x.example\n,b@x.example\na,c@x.example\n";
    let errors = errors(csv);
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(matches!(&errors[0], HistoryError::BadRow { row: 3, .. }));
    assert!(matches!(&errors[1], HistoryError::BadRow { row: 4, .. }));
}

#[test]
fn the_tb_with_an_account_code_column_uses_the_ytd_balances() {
    let tb = tb(TB_2025);
    assert_eq!(tb.as_at, Some(ymd(2025, 3, 31)));
    // The YTD column, not March's movement.
    assert_eq!(balance(&tb, "200"), -2_749_409);
    assert_eq!(balance(&tb, "880"), 1_440_000);
    assert_eq!(balance(&tb, "711"), -115_000);
    // GST was paid to nil at year end; the row is there for March's movement.
    assert_eq!(balance(&tb, "820"), 0);
    assert_eq!(
        tb.rows.iter().map(|r| r.balance).sum::<Money>(),
        Money::ZERO
    );
    let sales = tb.rows.iter().find(|r| r.code == "200").unwrap();
    assert_eq!(sales.name, "Pottery Sales");
    assert!(!tb.rows.iter().any(|r| r.name == "Total"));
}

#[test]
fn the_tb_with_sections_reads_the_code_from_the_account_cell() {
    let tb = tb(TB_2026);
    assert_eq!(tb.as_at, Some(ymd(2026, 3, 31)));
    assert_eq!(tb.rows.len(), 20);
    assert_eq!(balance(&tb, "960"), -1_652_053);
    assert_eq!(balance(&tb, "090"), 644_040);
    let row = tb.rows.iter().find(|r| r.code == "711").unwrap();
    assert_eq!(row.name, "Accumulated Depreciation - Kilns and Equipment");
}

#[test]
fn a_tb_that_does_not_balance_is_rejected() {
    let csv = "Trial Balance\nOrg\nAs at 31 March 2025\n\
               Account Code,Account,Debit,Credit\n\
               090,Bank,10.00,\n200,Sales,,9.99\n";
    assert_eq!(
        errors(csv),
        [HistoryError::Unbalanced {
            difference: Money::from_cents(1)
        }]
    );
}

#[test]
fn tb_row_problems_carry_the_row_and_column() {
    let csv = "Account,YTD Debit,YTD Credit\n\
               Revenue\n\
               Sales (200),,\"1,23.00\"\n\
               Bank,10.00,\n\
               Bank (090),5.00,\n\
               Bank again (090),1.00,\n";
    let errors = errors(csv);
    assert_eq!(errors.len(), 3, "{errors:?}");
    assert!(
        matches!(&errors[0], HistoryError::BadRow { row: 3, column, value, .. } if column == "YTD Credit" && value == "1,23.00")
    );
    assert!(
        matches!(&errors[1], HistoryError::BadRow { row: 4, reason, .. } if reason.contains("no code"))
    );
    assert!(
        matches!(&errors[2], HistoryError::BadRow { row: 6, reason, .. } if reason.contains("row 5"))
    );
}

#[test]
fn each_gl_reads_its_period_openings_and_lines() {
    let gl25 = gl(GL_2025);
    assert_eq!(gl25.from, Some(ymd(2024, 4, 1)));
    assert_eq!(gl25.to, Some(ymd(2025, 3, 31)));
    assert!(gl25.openings.is_empty());
    let first = &gl25.lines[0];
    assert_eq!(first.code, "090");
    assert_eq!(first.account_name, "Business Cheque Account");
    assert_eq!(first.date, ymd(2024, 4, 1));
    assert_eq!(first.source, "Receive Money");
    assert_eq!(first.amount, Money::from_cents(800_000));
    let invoice = gl25
        .lines
        .iter()
        .find(|l| l.code == "200" && l.source == "Receivable Invoice")
        .unwrap();
    assert!(invoice.amount < Money::ZERO);
    assert_eq!(invoice.reference, "INV-25001");

    let gl26 = gl(GL_2026);
    assert_eq!(gl26.from, Some(ymd(2025, 4, 1)));
    let opening = |code: &str| {
        gl26.openings
            .iter()
            .find(|o| o.code == code)
            .map(|o| o.balance.cents())
    };
    // Read from the running balance, credit in brackets.
    assert_eq!(opening("090"), Some(508_355));
    assert_eq!(opening("960"), Some(-1_652_053));
    assert_eq!(opening("200"), None);
}

/// M16's done check, from the Xero side: each year's GL detail sums to that year's TB.
#[test]
fn the_gl_detail_sums_to_the_tb() {
    assert_eq!(gl_differences(&gl(GL_2025), &tb(TB_2025)), []);
    assert_eq!(gl_differences(&gl(GL_2026), &tb(TB_2026)), []);
    // And the check would notice a mismatch.
    let diffs = gl_differences(&gl(GL_2025), &tb(TB_2026));
    assert!(diffs.iter().any(|d| d.code == "960"));
}

#[test]
fn an_ungrouped_gl_with_debit_credit_openings_reads() {
    let csv = "Account Code,Account,Date,Source,Description,Reference,Debit,Credit\n\
               090,Bank,,Opening Balance,,,100.00,\n\
               090,Bank,2 Apr 2025,Receive Money,Takings,,(5.00),\n\
               200,Sales,02/04/2025,Receive Money,Takings,,,\"1,005.00\"\n";
    // The opening row's first cell is the code, so it's recognised by its Source column.
    let gl = gl(csv);
    assert_eq!(gl.lines.len(), 2, "{gl:?}");
    assert_eq!(gl.openings[0].balance, Money::from_cents(10_000));
    assert_eq!(gl.lines[0].amount, Money::from_cents(-500));
    assert_eq!(gl.lines[1].amount, Money::from_cents(-100_500));
    assert_eq!(gl.lines[1].date, ymd(2025, 4, 2));
}

#[test]
fn gl_openings_can_be_in_debit_and_credit() {
    let csv = "Date,Source,Description,Reference,Debit,Credit,Running Balance\n\
               Trade Creditors (800)\n\
               Opening Balance,,,,,250.00,(250.00)\n\
               3 Apr 2025,Payable Payment,Clayworks,,250.00,,0.00\n";
    let gl = gl(csv);
    assert_eq!(gl.openings[0].code, "800");
    assert_eq!(gl.openings[0].balance, Money::from_cents(-25_000));
    assert_eq!(gl.lines[0].amount, Money::from_cents(25_000));
}

#[test]
fn gl_row_problems_carry_the_row_and_reason() {
    let csv = "Date,Source,Description,Reference,Debit,Credit\n\
               3 Apr 2025,Spend Money,Before a heading,,1.00,\n\
               Bank account with no code\n\
               Bank (090)\n\
               31 Feb 2025,Spend Money,Bad date,,1.00,\n\
               1 Mar 2025,Spend Money,Bad amount,,1.2.3,\n";
    let errors = errors(csv);
    assert_eq!(errors.len(), 4, "{errors:?}");
    assert!(
        matches!(&errors[0], HistoryError::BadRow { row: 2, reason, .. } if reason.contains("before any account"))
    );
    assert!(
        matches!(&errors[1], HistoryError::BadRow { row: 3, reason, .. } if reason.contains("no code"))
    );
    assert!(
        matches!(&errors[2], HistoryError::BadRow { row: 5, value, .. } if value == "31 Feb 2025")
    );
    assert!(matches!(&errors[3], HistoryError::BadRow { row: 6, column, .. } if column == "Debit"));
}

#[test]
fn amounts_parse_to_cents_without_floats() {
    let ok = |s: &str| amount(s).unwrap().cents();
    assert_eq!(ok("1,234.56"), 123_456);
    assert_eq!(ok("1,234,567.89"), 123_456_789);
    assert_eq!(ok("(1,234.56)"), -123_456);
    assert_eq!(ok("-1,234.56"), -123_456);
    assert_eq!(ok("( 12.30 )"), -1_230);
    assert_eq!(ok("$5"), 500);
    assert_eq!(ok("0.1"), 10);
    assert_eq!(ok(""), 0);
    assert_eq!(ok("  "), 0);
    // 0.1 + 0.2 is exactly 0.3 in cents.
    assert_eq!(ok("0.10") + ok("0.20"), ok("0.30"));
    for bad in [
        "1,23.00",
        "12,3456.00",
        "1.234",
        "(12.00",
        "12-",
        "abc",
        "1.2.3",
        ",",
    ] {
        assert!(amount(bad).is_err(), "{bad} should be rejected");
    }
}

#[test]
fn dates_and_account_cells_parse() {
    assert_eq!(date("1 Apr 2025"), Some(ymd(2025, 4, 1)));
    assert_eq!(date("01 April 2025"), Some(ymd(2025, 4, 1)));
    assert_eq!(date("01/04/2025"), Some(ymd(2025, 4, 1)));
    assert_eq!(date("2025-04-01"), Some(ymd(2025, 4, 1)));
    assert_eq!(date("April 2025"), None);
    assert_eq!(
        split_account("Sales (200)"),
        Some(("200".into(), "Sales".into()))
    );
    assert_eq!(
        split_account("Light, Power (Heating) (445)"),
        Some(("445".into(), "Light, Power (Heating)".into()))
    );
    assert_eq!(
        split_account("ABC-1 - Loan"),
        Some(("ABC-1".into(), "Loan".into()))
    );
    assert_eq!(split_account("Sales (Retail sales)"), None);
    assert_eq!(split_account("Revenue"), None);
}
