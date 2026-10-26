//! Tests over the synthetic exports in `fixtures/myob/` and hand-made broken files.

use acct_core::Money;
use chrono::NaiveDate;

use super::*;
use crate::history::{
    ContactKind, HistoryAccount, HistoryContact, HistoryGl, HistoryTb, SourceAccountType,
    gl_differences,
};

const AR_ACCOUNTS: &str = include_str!("../../../../fixtures/myob/accountright/accounts.txt");
const AR_TB_2024: &str = include_str!("../../../../fixtures/myob/accountright/tb-fy2024.csv");
const AR_TB_2025: &str = include_str!("../../../../fixtures/myob/accountright/tb-fy2025.csv");
const AR_GL_2024: &str = include_str!("../../../../fixtures/myob/accountright/gl-fy2024.csv");
const AR_GL_2025: &str = include_str!("../../../../fixtures/myob/accountright/gl-fy2025.csv");
const AR_CUSTOMERS: &str =
    include_str!("../../../../fixtures/myob/accountright/customer-cards.txt");
const AR_SUPPLIERS: &str =
    include_str!("../../../../fixtures/myob/accountright/supplier-cards.txt");
const BIZ_ACCOUNTS: &str = include_str!("../../../../fixtures/myob/business/accounts.txt");
const BIZ_TB_2025: &str = include_str!("../../../../fixtures/myob/business/tb-fy2025.csv");
const BIZ_GL_2025: &str = include_str!("../../../../fixtures/myob/business/gl-fy2025.csv");
const BIZ_CONTACTS: &str = include_str!("../../../../fixtures/myob/business/contacts.csv");

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn chart(text: &str) -> Vec<HistoryAccount> {
    match parse(text).unwrap().file {
        HistoryFile::Chart(accounts) => accounts,
        other => panic!("not a chart: {other:?}"),
    }
}

fn tb(text: &str) -> HistoryTb {
    match parse(text).unwrap().file {
        HistoryFile::Tb(tb) => tb,
        other => panic!("not a TB: {other:?}"),
    }
}

fn gl(text: &str) -> HistoryGl {
    match parse(text).unwrap().file {
        HistoryFile::Gl(gl) => gl,
        other => panic!("not a GL: {other:?}"),
    }
}

fn contacts(text: &str) -> Vec<HistoryContact> {
    match parse(text).unwrap().file {
        HistoryFile::Contacts(contacts) => contacts,
        other => panic!("not contacts: {other:?}"),
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

fn bad_rows(text: &str) -> Vec<(u32, String)> {
    errors(text)
        .into_iter()
        .map(|e| match e {
            HistoryError::BadRow { row, column, .. } => (row, column),
            other => panic!("not a row error: {other:?}"),
        })
        .collect()
}

// --- Detection ---

#[test]
fn every_fixture_is_detected() {
    use HistorySource::{MyobAccountRight as Ar, MyobBusiness as Biz};
    use MyobExport::*;
    let cases = [
        (AR_ACCOUNTS, Accounts, Ar),
        (AR_TB_2024, TrialBalance, Ar),
        (AR_TB_2025, TrialBalance, Ar),
        (AR_GL_2024, GeneralLedger, Ar),
        (AR_GL_2025, GeneralLedger, Ar),
        (AR_CUSTOMERS, Cards, Ar),
        (AR_SUPPLIERS, Cards, Ar),
        (BIZ_ACCOUNTS, Accounts, Biz),
        (BIZ_TB_2025, TrialBalance, Ar),
        (BIZ_GL_2025, GeneralLedger, Ar),
        (BIZ_CONTACTS, Contacts, Biz),
    ];
    for (i, (text, kind, source)) in cases.into_iter().enumerate() {
        assert_eq!(detect(text), Some((kind, source)), "case {i}");
        assert_eq!(parse(text).unwrap().source, source, "case {i}");
    }
}

#[test]
fn unknown_and_empty_files() {
    assert_eq!(detect("Date,Amount,Payee\n1/04/2024,10.00,Shop\n"), None);
    assert_eq!(
        errors("Date,Amount,Payee\n1/04/2024,10.00,Shop\n"),
        [HistoryError::UnknownFormat {
            header: vec!["Date".into(), "Amount".into(), "Payee".into()]
        }]
    );
    assert_eq!(errors(""), [HistoryError::Empty]);
    assert_eq!(errors("\u{feff}\r\n\r\n"), [HistoryError::Empty]);
}

#[test]
fn a_header_too_far_down_is_not_found() {
    let mut text = "Title\n".repeat(MAX_PREAMBLE + 1);
    text.push_str("Account No.,Account Name,Debit,Credit\n1-1110,Bank,1.00,\n");
    assert_eq!(detect(&text), None);
}

#[test]
fn the_import_template_brace_row_a_bom_and_crlf_are_tolerated() {
    let text = "\u{feff}{}\r\nAccount Number,Account Name,Account Type\r\n1-1110,Bank,Bank\r\n";
    assert_eq!(
        detect(text),
        Some((MyobExport::Accounts, HistorySource::MyobAccountRight))
    );
    assert_eq!(chart(text)[0].row, 3);
}

// --- Accounts list ---

#[test]
fn accountright_accounts_list() {
    let accounts = chart(AR_ACCOUNTS);
    assert_eq!(accounts.len(), 31);
    let find = |code: &str| accounts.iter().find(|a| a.code == code).unwrap();

    let bank = find("1-1110");
    assert_eq!(bank.name, "Business Cheque Account");
    assert_eq!(bank.account_type, SourceAccountType::Asset);
    assert_eq!(bank.source_type, "Bank");
    assert_eq!(bank.tax_code.as_deref(), Some("N-T"));
    assert!(!bank.is_header && bank.active);
    assert_eq!(bank.row, 4);

    assert!(find("1-0000").is_header);
    assert_eq!(find("1-0000").tax_code, None);
    assert!(!find("9-1000").active);
    assert_eq!(find("2-1500").account_type, SourceAccountType::Liability);
    assert_eq!(find("5-1000").account_type, SourceAccountType::CostOfSales);
    assert_eq!(find("8-1000").account_type, SourceAccountType::OtherIncome);
    assert_eq!(find("9-1000").account_type, SourceAccountType::OtherExpense);
}

#[test]
fn business_chart_matches_accountright_list() {
    let key = |a: &HistoryAccount| {
        (
            a.code.clone(),
            a.name.clone(),
            a.account_type,
            a.tax_code.clone(),
            a.is_header,
            a.active,
        )
    };
    let ar: Vec<_> = chart(AR_ACCOUNTS).iter().map(key).collect();
    let biz: Vec<_> = chart(BIZ_ACCOUNTS).iter().map(key).collect();
    assert_eq!(ar, biz);
}

#[test]
fn a_blank_type_falls_back_to_the_number() {
    let text = "Account Number\tAccount Name\tAccount Type\n4-1000\tFees\t\n";
    let accounts = chart(text);
    assert_eq!(accounts[0].account_type, SourceAccountType::Income);
    assert_eq!(accounts[0].source_type, "");
}

#[test]
fn bad_accounts_are_reported_by_row() {
    let text = "Account Number,Account Name,Account Type\n\
                1-1110,Bank,Bank\n\
                ,Blank number,Bank\n\
                1-1110,Again,Bank\n\
                X100,Mystery,Widget\n\
                1 1110,Spaced,Bank\n";
    assert_eq!(
        bad_rows(text),
        [
            (3, "Account Number".into()),
            (4, "Account Number".into()),
            (5, "Account Type".into()),
            (6, "Account Number".into()),
        ]
    );
}

// --- Trial balance ---

#[test]
fn accountright_trial_balances() {
    let fy24 = tb(AR_TB_2024);
    assert_eq!(fy24.as_at, Some(date(2024, 3, 31)));
    assert_eq!(
        fy24.rows.iter().map(|r| r.balance).sum::<Money>(),
        Money::ZERO
    );
    assert_eq!(balance(&fy24, "1-1110"), 721_172);
    assert_eq!(balance(&fy24, "1-2120"), -112_000);
    assert_eq!(balance(&fy24, "3-1100"), 150_000);
    assert_eq!(balance(&fy24, "8-1000"), -412);
    assert!(fy24.rows.iter().all(|r| !r.name.is_empty()));
    assert_eq!(fy24.rows[0].row, 6);

    let fy25 = tb(AR_TB_2025);
    assert_eq!(fy25.as_at, Some(date(2025, 3, 31)));
    assert_eq!(balance(&fy25, "1-1110"), 771_170);
    // The year-to-date columns, not March's.
    assert_eq!(balance(&fy25, "4-1000"), -580_000);
}

#[test]
fn business_trial_balance_matches_accountright() {
    let ar = tb(AR_TB_2025);
    let biz = tb(BIZ_TB_2025);
    assert_eq!(biz.as_at, ar.as_at);
    assert_eq!(biz.rows, ar.rows);
}

#[test]
fn only_the_month_columns_are_used_when_there_are_no_ytd_columns() {
    let text = "Account No.,Account Name,Debit,Credit\n1-1110,Bank,$5.00,\n4-1000,Fees,,$5.00\n";
    assert_eq!(balance(&tb(text), "4-1000"), -500);
}

#[test]
fn a_combined_account_cell_gives_the_number() {
    let text = "Account,Debit,Credit\n\
                Assets,,\n\
                1-1110 Business Cheque Account,10.00,\n\
                4-1000 Fees,,10.00\n\
                Total:,10.00,10.00\n";
    let t = tb(text);
    assert_eq!(t.as_at, None);
    assert_eq!(t.rows.len(), 2);
    assert_eq!(t.rows[0].code, "1-1110");
    assert_eq!(t.rows[0].name, "Business Cheque Account");
}

#[test]
fn a_tb_without_account_numbers_says_to_add_the_column() {
    let text = "Account,Debit,Credit\nBusiness Cheque Account,10.00,\nFees,,10.00\n";
    let errors = errors(text);
    assert_eq!(errors.len(), 2);
    assert!(matches!(
        &errors[0],
        HistoryError::BadRow { row: 2, reason, .. } if reason.contains("Account No.")
    ));
}

#[test]
fn tb_amount_edge_cases() {
    let text = "Account No.,Debit,Credit\n\
                1-1110,\"$1,000,000.01\",\n\
                1-2120,(0.01),\n\
                2-1200,,$-0.00\n\
                3-1000,,\"1,000,000.0000\"\n";
    let t = tb(text);
    assert_eq!(
        t.rows.iter().map(|r| r.balance.cents()).collect::<Vec<_>>(),
        [100_000_001, -1, 0, -100_000_000]
    );
}

#[test]
fn bad_tb_rows_are_all_reported() {
    let text = "Account No.,Account Name,Debit,Credit\n\
                1-1110,Bank,10.00,5.00\n\
                1-1200,Debtors,1.234,\n\
                1-1110,Bank again,,1.00\n\
                bad code!,X,1.00,\n\
                4-1000,Fees,,ten\n";
    assert_eq!(
        bad_rows(text),
        [
            (2, "Credit".into()),
            (3, "Debit".into()),
            (4, "Account No.".into()),
            (5, "Account No.".into()),
            (6, "Credit".into()),
        ]
    );
}

#[test]
fn a_tb_must_balance() {
    let text = "Account No.,Debit,Credit\n1-1110,10.00,\n4-1000,,9.99\n";
    assert_eq!(
        errors(text),
        [HistoryError::Unbalanced {
            difference: Money::from_cents(1)
        }]
    );
}

// --- General ledger detail ---

#[test]
fn accountright_gl_detail_sums_to_the_tb_each_year() {
    for (gl_text, tb_text, from, to, lines) in [
        (
            AR_GL_2024,
            AR_TB_2024,
            date(2023, 4, 1),
            date(2024, 3, 31),
            49,
        ),
        (
            AR_GL_2025,
            AR_TB_2025,
            date(2024, 4, 1),
            date(2025, 3, 31),
            40,
        ),
    ] {
        let g = gl(gl_text);
        assert_eq!((g.from, g.to), (Some(from), Some(to)));
        assert_eq!(g.lines.len(), lines);
        assert_eq!(gl_differences(&g, &tb(tb_text)), []);
        assert!(g.lines.iter().all(|l| l.date >= from && l.date <= to));
    }
}

#[test]
fn business_gl_detail_sums_to_its_tb_and_matches_accountright() {
    let biz = gl(BIZ_GL_2025);
    assert_eq!(gl_differences(&biz, &tb(BIZ_TB_2025)), []);
    let strip = |g: HistoryGl| {
        (
            g.from,
            g.to,
            g.openings
                .into_iter()
                .map(|o| (o.code, o.balance))
                .collect::<Vec<_>>(),
            g.lines
                .into_iter()
                .map(|l| {
                    (
                        l.code,
                        l.date,
                        l.reference,
                        l.source,
                        l.description,
                        l.amount,
                    )
                })
                .collect::<Vec<_>>(),
        )
    };
    let ar = strip(gl(AR_GL_2025));
    let biz = strip(biz);
    // The Business file has no card names, so memo-less lines differ; compare the rest.
    assert_eq!((ar.0, ar.1, &ar.2), (biz.0, biz.1, &biz.2));
    assert_eq!(ar.3.len(), biz.3.len());
    for (a, b) in ar.3.iter().zip(&biz.3) {
        assert_eq!((&a.0, a.1, &a.2, &a.3, a.5), (&b.0, b.1, &b.2, &b.3, b.5));
    }
}

#[test]
fn the_second_years_openings_are_the_first_years_closing() {
    let fy24 = tb(AR_TB_2024);
    let fy25 = gl(AR_GL_2025);
    let opening = |code: &str| {
        fy25.openings
            .iter()
            .find(|o| o.code == code)
            .map_or(0, |o| o.balance.cents())
    };
    let mut profit_and_loss = 0;
    for row in &fy24.rows {
        match fields::type_from_code(&row.code).unwrap() {
            t if t.is_balance_sheet() && row.code != "3-8000" => {
                assert_eq!(opening(&row.code), row.balance.cents(), "{}", row.code);
            }
            _ => profit_and_loss += row.balance.cents(),
        }
    }
    assert_eq!(
        opening("3-8000"),
        balance(&fy24, "3-8000") + profit_and_loss
    );
    assert_eq!(opening("3-8000"), -512_867);
    assert!(fy25.openings.iter().all(|o| !o.balance.is_zero()));
}

#[test]
fn gl_lines_carry_reference_source_memo_and_sign() {
    let g = gl(AR_GL_2025);
    let rent: Vec<_> = g
        .lines
        .iter()
        .filter(|l| l.reference == "CD000010")
        .collect();
    assert_eq!(rent.len(), 3);
    let bank = rent.iter().find(|l| l.code == "1-1110").unwrap();
    assert_eq!(bank.amount, Money::from_cents(-172_500));
    assert_eq!(bank.source, "CD");
    assert_eq!(bank.description, "Salon rent April-May");
    assert_eq!(bank.account_name, "Business Cheque Account");
    assert_eq!(bank.date, date(2024, 4, 15));
    assert_eq!(rent.iter().map(|l| l.amount).sum::<Money>(), Money::ZERO);
    // Credit-normal openings are credits; a contra asset's is a credit too.
    let opening = |code: &str| g.openings.iter().find(|o| o.code == code).unwrap().balance;
    assert_eq!(opening("3-1000"), Money::from_cents(-610_000));
    assert_eq!(opening("1-2120"), Money::from_cents(-112_000));
    assert_eq!(opening("3-1100"), Money::from_cents(150_000));
}

#[test]
fn a_memo_less_posting_uses_the_card_name() {
    let text = "Account No.,Account Name,ID No.,Src,Date,Memo,Name,Debit,Credit\n\
                1-1110,Bank,,,,Beginning Balance,,,\n\
                ,,CD1,CD,1/04/2024,,Kowhai Print Co,,5.00\n";
    assert_eq!(gl(text).lines[0].description, "Kowhai Print Co");
}

#[test]
fn a_separate_beginning_balance_row_and_debit_credit_openings() {
    let text = "Account,ID No.,Src,Date,Memo,Debit,Credit,Ending Balance\n\
                2-1500 Trade Creditors,,,,,,,\n\
                ,,,,Beginning Balance,,,$40.00\n\
                ,PJ1,PJ,2/04/2024,Order,,$10.00,$50.00\n\
                1-1110 Bank,,,,Beginning Balance,$25.00,,\n\
                ,CD1,CD,3/04/2024,Pay,,$5.00,$20.00\n";
    let g = gl(text);
    assert_eq!(
        g.openings
            .iter()
            .map(|o| (o.code.as_str(), o.balance.cents()))
            .collect::<Vec<_>>(),
        [("2-1500", -4_000), ("1-1110", 2_500)]
    );
    assert_eq!(g.lines[0].amount, Money::from_cents(-1_000));
    assert_eq!((g.from, g.to), (None, None));
}

#[test]
fn a_wrong_running_balance_is_reported() {
    // A file that signs a liability's balance as a debit fails the running-balance check.
    let text = "Account No.,Account Name,ID No.,Src,Date,Memo,Debit,Credit,Ending Balance\n\
                2-1500,Creditors,,,,Beginning Balance,,,-40.00\n\
                ,,PJ1,PJ,2/04/2024,Order,,10.00,-50.00\n";
    let errors = errors(text);
    assert_eq!(errors.len(), 1);
    assert!(matches!(
        &errors[0],
        HistoryError::BadRow { row: 3, column, reason, .. }
            if column == "Ending Balance" && reason.contains("30.00")
    ));
}

#[test]
fn bad_gl_rows_are_all_reported() {
    let text = "Account No.,Account Name,ID No.,Src,Date,Memo,Debit,Credit,Ending Balance\n\
                ,,CD0,CD,1/04/2024,Orphan,,1.00,\n\
                1-1110,Bank,,,,Beginning Balance,,,10.00\n\
                ,,CD1,CD,04/31/2024,US date,,1.00,\n\
                ,,CD2,CD,2/04/2024,Both,1.00,1.00,\n\
                ,,CD3,CD,3/04/2024,Bad amount,,1.001,\n\
                X-1,Unclassified,,,,Beginning Balance,,,5.00\n\
                4-1000,Fees,,,,Beginning Balance,,,0.00\n\
                1-1110,Bank again,,,,Beginning Balance,,,10.00\n";
    assert_eq!(
        bad_rows(text),
        [
            (2, "Account No.".into()),
            (4, "Date".into()),
            (5, "Credit".into()),
            (6, "Credit".into()),
            (7, "Ending Balance".into()),
            (9, "Account No.".into()),
        ]
    );
}

// --- Contacts ---

#[test]
fn accountright_cards() {
    let customers = contacts(AR_CUSTOMERS);
    assert_eq!(customers.len(), 3);
    assert!(customers.iter().all(|c| c.kind == ContactKind::Customer));
    assert_eq!(customers[0].name, "Totara Kennel Club");
    assert_eq!(customers[0].gst_number.as_deref(), Some("000-111-222"));
    assert_eq!(customers[0].email.as_deref(), Some("shows@example.com"));
    assert_eq!(customers[0].phone.as_deref(), Some("021 555 0101"));
    assert_eq!(customers[1].name, "Mere Wren");
    assert_eq!(customers[1].email, None);

    let suppliers = contacts(AR_SUPPLIERS);
    assert_eq!(suppliers.len(), 3);
    assert!(suppliers.iter().all(|c| c.kind == ContactKind::Supplier));
    assert_eq!(suppliers[2].phone, None);
}

#[test]
fn personal_cards_are_other() {
    let text = "Co./Last Name\tFirst Name\tCard ID\nWren\tMere\t*None\n";
    assert_eq!(contacts(text)[0].kind, ContactKind::Other);
}

#[test]
fn business_contacts() {
    let c = contacts(BIZ_CONTACTS);
    let kinds: Vec<_> = c.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            ContactKind::Customer,
            ContactKind::Supplier,
            ContactKind::Both,
            ContactKind::Other
        ]
    );
    assert_eq!(c[0].gst_number.as_deref(), Some("000-111-222"));
    assert_eq!(c[2].email, None);
}

#[test]
fn bad_contacts_are_reported_by_row() {
    let text = "Contact name,Contact type\nA,Customer\n,Supplier\nB,Robot\n";
    assert_eq!(
        bad_rows(text),
        [(3, "Co./Last Name".into()), (4, "Contact type".into())]
    );
}
