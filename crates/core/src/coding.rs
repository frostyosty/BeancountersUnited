//! Categorising a bank line (Save tax, M11): what a line can be coded as, the journal lines each
//! coding posts, and the per-business rules that pick a coding from a line's description.
//!
//! The rules are in `docs/domain.md` under "Bank statements to the ledger", "GST" and
//! "Sole-trader chart and template". A coded line replaces the conservative posting in
//! [`crate::bank::unsorted_lines`]: the server reverses that journal and posts these lines.

use std::cmp::Reverse;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::chart::{AccountCode, AccountType, Chart, GstCode};
use crate::ledger::JournalLine;
use crate::money::{Money, div_round_half_away, money_from_i128};
use crate::tax::gst::{gst_in_inclusive, gst_rate_bp};

/// Basis points in 100%.
const BP: u32 = 10_000;

/// GST on a withdrawal over this amount (GST-inclusive, the whole bank line) is claimed only once
/// the owner confirms they hold the supplier's taxable supply information.
pub const SUPPLY_INFO_THRESHOLD: Money = Money::from_cents(20_000);

/// Money in or money out, as the bank shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    /// The direction of a signed bank amount, or `None` for a nil amount.
    pub fn of(amount: Money) -> Option<Direction> {
        match amount.cents() {
            0 => None,
            c if c > 0 => Some(Direction::In),
            _ => Some(Direction::Out),
        }
    }
}

/// What a deposit is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DepositCoding {
    /// Business income to an income account, GST-inclusive. `gst` is `standard`, `zero` or
    /// `exempt`; `none` isn't allowed on income.
    Income { account: AccountCode, gst: GstCode },
    /// Not income: a transfer from another of the business's bank or card accounts.
    Transfer { from: AccountCode },
    /// Not income: a loan received.
    Loan,
    /// Not income: money the owner put in.
    OwnerFunds,
    /// Not income: a GST refund from IRD.
    GstRefund,
    /// Not income: wages already taxed through PAYE.
    PayeWages,
    /// Not income: the sale of a personal item.
    PersonalSale,
}

/// What a withdrawal is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WithdrawalCoding {
    /// A business expense, to an expense account.
    Expense { account: AccountCode, gst: GstCode },
    /// Partly private: `business_bp` of the line (0 to 10,000) is a business expense, and the rest
    /// is drawings. The amount and the GST claimed both follow the business share.
    PartPrivate {
        account: AccountCode,
        gst: GstCode,
        business_bp: u32,
    },
    /// An asset purchase, to the cost account of the asset's class. Adding it to the register is
    /// the server's job.
    AssetPurchase { account: AccountCode, gst: GstCode },
    /// Personal spending: drawings.
    Personal,
    /// A transfer to another of the business's bank or card accounts (paying off a card, say).
    Transfer { to: AccountCode },
    /// A GST payment to IRD.
    IrdGst,
    /// An income tax payment to IRD.
    IrdIncomeTax,
}

/// What a bank line is coded as. Its direction must match the line's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum Coding {
    In(DepositCoding),
    Out(WithdrawalCoding),
}

impl Coding {
    pub fn direction(&self) -> Direction {
        match self {
            Coding::In(_) => Direction::In,
            Coding::Out(_) => Direction::Out,
        }
    }
}

/// How the GST on a partly private line is worked out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartPrivateGst {
    /// The GST inside the business share.
    #[default]
    BusinessShare,
    /// The GST inside the whole line, times the business share. Can differ by a cent.
    ShareOfTotal,
}

/// A business's coding settings: the accounts codings post to without naming them, and how
/// partly private GST is worked out. The practice's defaults are in
/// `fixtures/practice/sole-trader-coding-settings.json`; accountants can change them per
/// business, and a change applies only to lines coded after it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingSettings {
    /// GST collected and paid (810 in the sole-trader chart). Liability or asset.
    pub gst: AccountCode,
    /// GST to claim, records not yet held (615): GST on a line over the supply information
    /// threshold, until the owner confirms. An asset.
    pub unclaimed_gst: AccountCode,
    /// GST refunds received (812). Liability or asset.
    pub gst_refund: AccountCode,
    /// Owner's capital (950): money the owner put in. Equity.
    pub capital: AccountCode,
    /// Wages already taxed through PAYE, paid into the business account (952). Equity.
    pub paye_wages: AccountCode,
    /// Personal items sold (954). Equity.
    pub personal_sale: AccountCode,
    /// Drawings (960): personal spending and the private share of a line. Equity.
    pub drawings: AccountCode,
    /// Income tax paid (962). Equity.
    pub income_tax: AccountCode,
    /// Loans (900). Liability.
    pub loans: AccountCode,
    #[serde(default)]
    pub part_private_gst: PartPrivateGst,
}

impl CodingSettings {
    /// Every account exists in `chart`, is active, and is of the type its field needs.
    pub fn validate(&self, chart: &Chart) -> Result<(), CodingError> {
        use AccountType::{Asset, Equity, Liability};
        check(chart, &self.gst, &[Liability, Asset])?;
        check(chart, &self.unclaimed_gst, &[Asset])?;
        check(chart, &self.gst_refund, &[Liability, Asset])?;
        for equity in [
            &self.capital,
            &self.paye_wages,
            &self.personal_sale,
            &self.drawings,
            &self.income_tax,
        ] {
            check(chart, equity, &[Equity])?;
        }
        check(chart, &self.loans, &[Liability])
    }
}

/// One bank line: the bank (or card) account, the posting date, and the amount signed as the bank
/// shows it, positive for money in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankLine<'a> {
    pub bank: &'a AccountCode,
    pub date: NaiveDate,
    pub amount: Money,
}

/// The business facts a coding needs.
#[derive(Debug, Clone, Copy)]
pub struct CodingContext<'a> {
    pub chart: &'a Chart,
    pub settings: &'a CodingSettings,
    /// The owner's GST registration date, if they're registered.
    pub gst_registered_from: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum CodingError {
    #[error("this line is money {line:?}, but the coding is for money {coding:?}")]
    WrongDirection { line: Direction, coding: Direction },
    #[error("there's no account {account} in the chart")]
    UnknownAccount { account: AccountCode },
    #[error("account {account} is inactive")]
    InactiveAccount { account: AccountCode },
    #[error("account {account} is {actual:?}, but this coding needs {expected:?}")]
    WrongAccountType {
        account: AccountCode,
        expected: Vec<AccountType>,
        actual: AccountType,
    },
    #[error("income can be standard, zero-rated or exempt, but not outside GST")]
    IncomeOutsideGst,
    #[error("a business share of {business_bp} bp is over 100%")]
    ShareOver100 { business_bp: u32 },
    #[error("a transfer needs two different accounts, but both are {account}")]
    TransferToSelf { account: AccountCode },
}

/// The journal lines for `line` coded as `coding`, debits positive. A nil amount posts nothing.
///
/// - GST applies only from the registration date, at the rate for the line's date, and only on a
///   `standard` code. Zero-rated, exempt and outside-GST lines post GST-inclusive amounts whole.
/// - On a withdrawal over [`SUPPLY_INFO_THRESHOLD`], GST is claimed only if
///   `supply_info_confirmed` holds the date the owner confirmed they hold the supplier's taxable
///   supply information. Until then the expense or asset is still GST-exclusive, and the GST
///   waits in [`CodingSettings::unclaimed_gst`]: input tax is never an income tax deduction.
/// - Every account the coding names must exist in the chart, be active, and be of the right type.
pub fn coded_lines(
    line: &BankLine<'_>,
    coding: &Coding,
    supply_info_confirmed: Option<NaiveDate>,
    ctx: &CodingContext<'_>,
) -> Result<Vec<JournalLine>, CodingError> {
    use AccountType::{Asset, Expense, Income, Liability};

    let Some(direction) = Direction::of(line.amount) else {
        return Ok(Vec::new());
    };
    if direction != coding.direction() {
        return Err(CodingError::WrongDirection {
            line: direction,
            coding: coding.direction(),
        });
    }
    check(ctx.chart, line.bank, &[Asset, Liability])?;
    let a = ctx.settings;
    a.validate(ctx.chart)?;

    // The GST rate if the owner is registered on this date.
    let rate = ctx
        .gst_registered_from
        .filter(|&from| line.date >= from)
        .and_then(|_| gst_rate_bp(line.date));
    let mut out = Lines::default();

    match coding {
        Coding::In(deposit) => {
            let amount = line.amount;
            out.push(line.bank, amount);
            match deposit {
                DepositCoding::Income { account, gst } => {
                    check(ctx.chart, account, &[Income])?;
                    if *gst == GstCode::None {
                        return Err(CodingError::IncomeOutsideGst);
                    }
                    let tax = gst_on(amount, *gst, rate);
                    out.push(&a.gst, -tax);
                    out.push(account, -(amount - tax));
                }
                DepositCoding::Transfer { from } => {
                    check(ctx.chart, from, &[Asset, Liability])?;
                    not_self(line.bank, from)?;
                    out.push(from, -amount);
                }
                DepositCoding::Loan => out.push(&a.loans, -amount),
                DepositCoding::GstRefund => out.push(&a.gst_refund, -amount),
                DepositCoding::OwnerFunds => out.push(&a.capital, -amount),
                DepositCoding::PayeWages => out.push(&a.paye_wages, -amount),
                DepositCoding::PersonalSale => out.push(&a.personal_sale, -amount),
            }
        }
        Coding::Out(withdrawal) => {
            // Positive from here: what left the bank.
            let spent = -line.amount;
            // Over the threshold and not confirmed, the GST waits in its own account.
            let gst_to = if spent > SUPPLY_INFO_THRESHOLD && supply_info_confirmed.is_none() {
                &a.unclaimed_gst
            } else {
                &a.gst
            };
            match withdrawal {
                WithdrawalCoding::Expense { account, gst } => {
                    check(ctx.chart, account, &[Expense])?;
                    out.purchase(account, gst_to, spent, gst_on(spent, *gst, rate));
                }
                WithdrawalCoding::AssetPurchase { account, gst } => {
                    check(ctx.chart, account, &[Asset])?;
                    out.purchase(account, gst_to, spent, gst_on(spent, *gst, rate));
                }
                WithdrawalCoding::PartPrivate {
                    account,
                    gst,
                    business_bp,
                } => {
                    check(ctx.chart, account, &[Expense])?;
                    let business = business_share(spent, *business_bp)?;
                    let tax = match a.part_private_gst {
                        PartPrivateGst::BusinessShare => gst_on(business, *gst, rate),
                        PartPrivateGst::ShareOfTotal => {
                            business_share(gst_on(spent, *gst, rate), *business_bp)?
                        }
                    };
                    out.purchase(account, gst_to, business, tax);
                    out.push(&a.drawings, spent - business);
                }
                WithdrawalCoding::Personal => out.push(&a.drawings, spent),
                WithdrawalCoding::IrdIncomeTax => out.push(&a.income_tax, spent),
                WithdrawalCoding::Transfer { to } => {
                    check(ctx.chart, to, &[Asset, Liability])?;
                    not_self(line.bank, to)?;
                    out.push(to, spent);
                }
                WithdrawalCoding::IrdGst => out.push(&a.gst, spent),
            }
            out.push(line.bank, line.amount);
        }
    }
    Ok(out.0)
}

/// `amount × business_bp ÷ 10,000`, rounded half away from zero to cents. The private share is
/// the rest, so the two always foot to the line.
pub fn business_share(amount: Money, business_bp: u32) -> Result<Money, CodingError> {
    if business_bp > BP {
        return Err(CodingError::ShareOver100 { business_bp });
    }
    Ok(money_from_i128(div_round_half_away(
        i128::from(amount.cents()) * i128::from(business_bp),
        i128::from(BP),
    )))
}

/// The GST inside a GST-inclusive `amount` with code `gst`, or nothing if no rate applies.
fn gst_on(amount: Money, gst: GstCode, rate: Option<u32>) -> Money {
    match (gst, rate) {
        (GstCode::Standard, Some(r)) => gst_in_inclusive(amount, r),
        _ => Money::ZERO,
    }
}

/// Journal lines under construction. Nil lines are left out.
#[derive(Default)]
struct Lines(Vec<JournalLine>);

impl Lines {
    fn push(&mut self, account: &AccountCode, amount: Money) {
        if !amount.is_zero() {
            self.0.push(JournalLine {
                account: account.clone(),
                amount,
            });
        }
    }

    /// Debit `spent` (GST-inclusive) to `account`, less its GST `tax`, which goes to `gst_account`.
    fn purchase(
        &mut self,
        account: &AccountCode,
        gst_account: &AccountCode,
        spent: Money,
        tax: Money,
    ) {
        self.push(account, spent - tax);
        self.push(gst_account, tax);
    }
}

fn check(chart: &Chart, code: &AccountCode, allowed: &[AccountType]) -> Result<(), CodingError> {
    let account = chart.get(code).ok_or_else(|| CodingError::UnknownAccount {
        account: code.clone(),
    })?;
    if !account.active {
        return Err(CodingError::InactiveAccount {
            account: code.clone(),
        });
    }
    if !allowed.contains(&account.account_type) {
        return Err(CodingError::WrongAccountType {
            account: code.clone(),
            expected: allowed.to_vec(),
            actual: account.account_type,
        });
    }
    Ok(())
}

fn not_self(bank: &AccountCode, other: &AccountCode) -> Result<(), CodingError> {
    if bank == other {
        return Err(CodingError::TransferToSelf {
            account: bank.clone(),
        });
    }
    Ok(())
}

/// A business's rule, such as "always treat COUNTDOWN as personal". It matches a line when:
/// - the line's description contains `description_contains`, ignoring case and runs of spaces;
/// - the size of the amount is within `min` and `max`, both included, where given;
/// - the line's direction is the coding's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    /// Breaks ties between equally specific rules: the smallest id wins.
    pub id: String,
    pub description_contains: String,
    pub min: Option<Money>,
    pub max: Option<Money>,
    pub coding: Coding,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RuleError {
    #[error("a rule's amounts are sizes, so they can't be negative")]
    NegativeAmount,
    #[error("the rule's lowest amount is above its highest")]
    MinAboveMax,
}

impl Rule {
    pub fn validate(&self) -> Result<(), RuleError> {
        if self.min.is_some_and(|m| m < Money::ZERO) || self.max.is_some_and(|m| m < Money::ZERO) {
            return Err(RuleError::NegativeAmount);
        }
        if let (Some(min), Some(max)) = (self.min, self.max)
            && min > max
        {
            return Err(RuleError::MinAboveMax);
        }
        Ok(())
    }

    /// Whether this rule matches a line. `description` is normalised here, so it can be raw.
    pub fn matches(&self, description: &str, amount: Money) -> bool {
        let Some(direction) = Direction::of(amount) else {
            return false;
        };
        let size = if amount < Money::ZERO {
            -amount
        } else {
            amount
        };
        direction == self.coding.direction()
            && self.min.is_none_or(|m| size >= m)
            && self.max.is_none_or(|m| size <= m)
            && normalise(description).contains(&normalise(&self.description_contains))
    }

    /// Bigger is more specific: longer text first, then more amount bounds, then a narrower range.
    fn specificity(&self) -> (usize, usize, Reverse<i64>) {
        let text = normalise(&self.description_contains).chars().count();
        let bounds = usize::from(self.min.is_some()) + usize::from(self.max.is_some());
        let width = match (self.min, self.max) {
            (Some(min), Some(max)) => (max - min).cents(),
            _ => 0,
        };
        (text, bounds, Reverse(width))
    }
}

/// The most specific rule that matches the line, or `None`. Ties go to the smallest id, so the
/// answer never depends on the rules' order.
pub fn best_rule<'a>(rules: &'a [Rule], description: &str, amount: Money) -> Option<&'a Rule> {
    rules
        .iter()
        .filter(|r| r.matches(description, amount))
        .max_by_key(|r| (r.specificity(), Reverse(r.id.as_str())))
}

/// Upper case, with runs of whitespace as single spaces and none at either end.
fn normalise(s: &str) -> String {
    s.split_whitespace()
        .map(str::to_uppercase)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::Account;
    use proptest::prelude::*;

    const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");

    fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    /// The sole-trader master chart, plus two bank accounts and a card, as a client would add them.
    fn chart() -> Chart {
        let mut accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
        for (c, name, t) in [
            ("600.01", "Cheque account", AccountType::Asset),
            ("600.02", "Business account", AccountType::Asset),
            ("850.01", "Credit card", AccountType::Liability),
        ] {
            accounts.push(Account {
                code: code(c),
                name: name.into(),
                account_type: t,
                active: true,
                default_gst: None,
            });
        }
        Chart::new(accounts).unwrap()
    }

    const SETTINGS: &str =
        include_str!("../../../fixtures/practice/sole-trader-coding-settings.json");

    /// The practice's default settings for sole traders.
    fn settings() -> CodingSettings {
        serde_json::from_str(SETTINGS).unwrap()
    }

    const REGISTERED: &str = "2025-08-01";

    /// Codes a line on 1 September 2025, after registering, with the given confirmation.
    fn post(
        amount: &str,
        coding: &Coding,
        confirmed: bool,
    ) -> Result<Vec<(String, Money)>, CodingError> {
        post_with(amount, coding, confirmed, Some(d(REGISTERED)), "2025-09-01")
    }

    fn post_with(
        amount: &str,
        coding: &Coding,
        confirmed: bool,
        registered: Option<NaiveDate>,
        date: &str,
    ) -> Result<Vec<(String, Money)>, CodingError> {
        post_full(amount, coding, confirmed, registered, date, &settings())
    }

    fn post_full(
        amount: &str,
        coding: &Coding,
        confirmed: bool,
        registered: Option<NaiveDate>,
        date: &str,
        settings: &CodingSettings,
    ) -> Result<Vec<(String, Money)>, CodingError> {
        let chart = chart();
        let bank = code("600.01");
        let ctx = CodingContext {
            chart: &chart,
            settings,
            gst_registered_from: registered,
        };
        let line = BankLine {
            bank: &bank,
            date: d(date),
            amount: m(amount),
        };
        let lines = coded_lines(&line, coding, confirmed.then(|| d("2025-09-02")), &ctx)?;
        Ok(lines
            .into_iter()
            .map(|l| (l.account.as_str().to_owned(), l.amount))
            .collect())
    }

    fn pairs(expected: &[(&str, &str)]) -> Vec<(String, Money)> {
        expected
            .iter()
            .map(|&(a, x)| (a.to_owned(), m(x)))
            .collect()
    }

    fn expense(account: &str, gst: GstCode) -> Coding {
        Coding::Out(WithdrawalCoding::Expense {
            account: code(account),
            gst,
        })
    }

    fn part_private(account: &str, business_bp: u32) -> Coding {
        Coding::Out(WithdrawalCoding::PartPrivate {
            account: code(account),
            gst: GstCode::Standard,
            business_bp,
        })
    }

    /// One of every coding, valid against the test chart.
    fn every_coding() -> Vec<Coding> {
        use DepositCoding as D;
        use WithdrawalCoding as W;
        let mut all: Vec<Coding> = [GstCode::Standard, GstCode::Zero, GstCode::Exempt]
            .into_iter()
            .map(|gst| {
                Coding::In(D::Income {
                    account: code("100"),
                    gst,
                })
            })
            .collect();
        all.extend(
            [
                D::Transfer {
                    from: code("600.02"),
                },
                D::Loan,
                D::OwnerFunds,
                D::GstRefund,
                D::PayeWages,
                D::PersonalSale,
            ]
            .map(Coding::In),
        );
        for gst in [
            GstCode::Standard,
            GstCode::Zero,
            GstCode::Exempt,
            GstCode::None,
        ] {
            all.push(expense("230", gst));
            all.push(Coding::Out(W::AssetPurchase {
                account: code("720"),
                gst,
            }));
            all.push(Coding::Out(W::PartPrivate {
                account: code("245"),
                gst,
                business_bp: 6_000,
            }));
        }
        all.extend(
            [
                W::Personal,
                W::Transfer { to: code("850.01") },
                W::IrdGst,
                W::IrdIncomeTax,
            ]
            .map(Coding::Out),
        );
        all
    }

    fn total(lines: &[(String, Money)]) -> Money {
        lines.iter().map(|(_, x)| *x).sum()
    }

    #[test]
    fn every_coding_balances() {
        for coding in every_coding() {
            let amount = match coding.direction() {
                Direction::In => "1,234.57",
                Direction::Out => "-1,234.57",
            };
            for registered in [None, Some(d(REGISTERED))] {
                for confirmed in [false, true] {
                    let lines = post_with(amount, &coding, confirmed, registered, "2025-09-01")
                        .unwrap_or_else(|e| panic!("{coding:?}: {e}"));
                    assert!(lines.len() >= 2, "{coding:?}");
                    assert_eq!(total(&lines), Money::ZERO, "{coding:?}");
                    let on_bank: Money = lines
                        .iter()
                        .filter(|(a, _)| a == "600.01")
                        .map(|(_, x)| *x)
                        .sum();
                    assert_eq!(on_bank, m(amount), "{coding:?}");
                }
            }
        }
    }

    #[test]
    fn income_is_split_for_gst_only_when_standard_and_registered() {
        let income = |gst| {
            Coding::In(DepositCoding::Income {
                account: code("100"),
                gst,
            })
        };
        assert_eq!(
            post("115.00", &income(GstCode::Standard), false).unwrap(),
            pairs(&[("600.01", "115.00"), ("810", "-15.00"), ("100", "-100.00")])
        );
        for gst in [GstCode::Zero, GstCode::Exempt] {
            assert_eq!(
                post("115.00", &income(gst), false).unwrap(),
                pairs(&[("600.01", "115.00"), ("100", "-115.00")])
            );
        }
        // Not registered, or before the registration date: no GST.
        let standard = income(GstCode::Standard);
        let whole = pairs(&[("600.01", "115.00"), ("100", "-115.00")]);
        assert_eq!(
            post_with("115.00", &standard, false, None, "2025-09-01").unwrap(),
            whole
        );
        assert_eq!(
            post_with(
                "115.00",
                &standard,
                false,
                Some(d(REGISTERED)),
                "2025-07-31"
            )
            .unwrap(),
            whole
        );
        assert_eq!(
            post("115.00", &income(GstCode::None), false),
            Err(CodingError::IncomeOutsideGst)
        );
    }

    #[test]
    fn deposits_that_are_not_income() {
        use DepositCoding as D;
        let cases = [
            (
                D::Transfer {
                    from: code("600.02"),
                },
                "600.02",
            ),
            (D::Loan, "900"),
            (D::OwnerFunds, "950"),
            (D::GstRefund, "812"),
            (D::PayeWages, "952"),
            (D::PersonalSale, "954"),
        ];
        for (coding, account) in cases {
            assert_eq!(
                post("163.42", &Coding::In(coding), false).unwrap(),
                pairs(&[("600.01", "163.42"), (account, "-163.42")])
            );
        }
    }

    #[test]
    fn withdrawals_that_are_not_expenses() {
        use WithdrawalCoding as W;
        let cases = [
            (W::Personal, "960"),
            (W::Transfer { to: code("850.01") }, "850.01"),
            (W::IrdGst, "810"),
            (W::IrdIncomeTax, "962"),
        ];
        for (coding, account) in cases {
            assert_eq!(
                post("-500.00", &Coding::Out(coding), false).unwrap(),
                pairs(&[(account, "500.00"), ("600.01", "-500.00")])
            );
        }
    }

    /// Up to $200 the bank line is enough. Over it, the GST waits in 615 until the owner confirms,
    /// and the expense is GST-exclusive either way.
    #[test]
    fn supply_information_tiers() {
        let rent = expense("230", GstCode::Standard);
        assert_eq!(
            post("-200.00", &rent, false).unwrap(),
            pairs(&[("230", "173.91"), ("810", "26.09"), ("600.01", "-200.00")])
        );
        assert_eq!(
            post("-200.01", &rent, false).unwrap(),
            pairs(&[("230", "173.92"), ("615", "26.09"), ("600.01", "-200.01")])
        );
        assert_eq!(
            post("-200.01", &rent, true).unwrap(),
            pairs(&[("230", "173.92"), ("810", "26.09"), ("600.01", "-200.01")])
        );
        // The tier is on the whole line, even when the business share is under $200.
        assert_eq!(
            post("-300.00", &part_private("245", 5_000), false).unwrap(),
            pairs(&[
                ("245", "130.43"),
                ("615", "19.57"),
                ("960", "150.00"),
                ("600.01", "-300.00")
            ])
        );
        // Asset purchases follow the same tiers.
        let laptop = Coding::Out(WithdrawalCoding::AssetPurchase {
            account: code("720"),
            gst: GstCode::Standard,
        });
        assert_eq!(
            post("-2,300.00", &laptop, false).unwrap(),
            pairs(&[
                ("720", "2,000.00"),
                ("615", "300.00"),
                ("600.01", "-2,300.00")
            ])
        );
        assert_eq!(
            post("-2,300.00", &laptop, true).unwrap(),
            pairs(&[
                ("720", "2,000.00"),
                ("810", "300.00"),
                ("600.01", "-2,300.00")
            ])
        );
    }

    /// The Save tax worked example's Faro insurance premium, not confirmed.
    #[test]
    fn worked_example_unconfirmed_premium() {
        assert_eq!(
            post("-215.00", &expense("215", GstCode::Standard), false).unwrap(),
            pairs(&[("215", "186.96"), ("615", "28.04"), ("600.01", "-215.00")])
        );
    }

    #[test]
    fn only_standard_codes_claim_gst() {
        for gst in [GstCode::Zero, GstCode::Exempt, GstCode::None] {
            assert_eq!(
                post("-115.00", &expense("205", gst), true).unwrap(),
                pairs(&[("205", "115.00"), ("600.01", "-115.00")])
            );
        }
    }

    /// The business share and the private share foot to the line, and GST follows the business
    /// share.
    #[test]
    fn part_private_splits_foot() {
        // 33.33% of 100.00 is 33.33: GST 4.35 on that, 28.98 expense, 66.67 drawings.
        assert_eq!(
            post("-100.00", &part_private("245", 3_333), false).unwrap(),
            pairs(&[
                ("245", "28.98"),
                ("810", "4.35"),
                ("960", "66.67"),
                ("600.01", "-100.00")
            ])
        );
        // 0.005 rounds away from zero: 50% of 0.01 is 0.01 business, nothing private.
        assert_eq!(
            post("-0.01", &part_private("245", 5_000), false).unwrap(),
            pairs(&[("245", "0.01"), ("600.01", "-0.01")])
        );
        // The ends: all private, all business.
        assert_eq!(
            post("-57.50", &part_private("245", 0), false).unwrap(),
            pairs(&[("960", "57.50"), ("600.01", "-57.50")])
        );
        assert_eq!(
            post("-57.50", &part_private("245", 10_000), false).unwrap(),
            pairs(&[("245", "50.00"), ("810", "7.50"), ("600.01", "-57.50")])
        );
        assert_eq!(
            post("-57.50", &part_private("245", 10_001), false),
            Err(CodingError::ShareOver100 {
                business_bp: 10_001
            })
        );
    }

    /// The other way to work out partly private GST: the line's GST times the business share.
    #[test]
    fn part_private_gst_can_be_a_share_of_the_total() {
        let share_of_total = CodingSettings {
            part_private_gst: PartPrivateGst::ShareOfTotal,
            ..settings()
        };
        let registered = Some(d(REGISTERED));
        let post = |amount: &str, coding: &Coding, s: &CodingSettings| {
            post_full(amount, coding, false, registered, "2025-09-01", s).unwrap()
        };
        // Usually the two agree: 100.00 at 33.33% claims 4.35 either way.
        let third = part_private("245", 3_333);
        assert_eq!(
            post("-100.00", &third, &settings()),
            post("-100.00", &third, &share_of_total)
        );
        // A cent apart: 0.38 at 50%. The business share, 0.19, holds 0.02 (0.0248); the line holds
        // 0.05 (0.0496), and half of that is 0.03 (0.025 rounds away from zero).
        let half = part_private("245", 5_000);
        assert_eq!(
            post("-0.38", &half, &settings()),
            pairs(&[
                ("245", "0.17"),
                ("810", "0.02"),
                ("960", "0.19"),
                ("600.01", "-0.38")
            ])
        );
        assert_eq!(
            post("-0.38", &half, &share_of_total),
            pairs(&[
                ("245", "0.16"),
                ("810", "0.03"),
                ("960", "0.19"),
                ("600.01", "-0.38")
            ])
        );
    }

    #[test]
    fn default_settings_fit_the_chart() {
        settings().validate(&chart()).unwrap();
        assert_eq!(settings().part_private_gst, PartPrivateGst::BusinessShare);
        // Each account must be of the right type.
        let wrong = CodingSettings {
            income_tax: code("290"),
            ..settings()
        };
        assert!(matches!(
            wrong.validate(&chart()),
            Err(CodingError::WrongAccountType { .. })
        ));
        let wrong = CodingSettings {
            unclaimed_gst: code("810"),
            ..settings()
        };
        assert!(matches!(
            wrong.validate(&chart()),
            Err(CodingError::WrongAccountType { .. })
        ));
    }

    #[test]
    fn rejects_bad_codings() {
        assert_eq!(
            post("100.00", &expense("230", GstCode::Standard), false),
            Err(CodingError::WrongDirection {
                line: Direction::In,
                coding: Direction::Out
            })
        );
        assert!(matches!(
            post("-100.00", &expense("100", GstCode::Standard), false),
            Err(CodingError::WrongAccountType { .. })
        ));
        assert!(matches!(
            post("-100.00", &expense("999", GstCode::Standard), false),
            Err(CodingError::UnknownAccount { .. })
        ));
        assert!(matches!(
            post(
                "-100.00",
                &Coding::Out(WithdrawalCoding::Transfer { to: code("960") }),
                false
            ),
            Err(CodingError::WrongAccountType { .. })
        ));
        assert_eq!(
            post(
                "-100.00",
                &Coding::Out(WithdrawalCoding::Transfer { to: code("600.01") }),
                false
            ),
            Err(CodingError::TransferToSelf {
                account: code("600.01")
            })
        );
        // Inactive accounts can't be posted to.
        let chart = chart().with_active(&code("230"), false).unwrap();
        let settings = settings();
        let bank = code("600.01");
        let ctx = CodingContext {
            chart: &chart,
            settings: &settings,
            gst_registered_from: None,
        };
        let line = BankLine {
            bank: &bank,
            date: d("2025-09-01"),
            amount: m("-10.00"),
        };
        assert_eq!(
            coded_lines(&line, &expense("230", GstCode::Standard), None, &ctx),
            Err(CodingError::InactiveAccount {
                account: code("230")
            })
        );
    }

    #[test]
    fn nil_posts_nothing() {
        assert_eq!(
            post("0.00", &expense("230", GstCode::Standard), false),
            Ok(vec![])
        );
    }

    #[test]
    fn codings_round_trip_as_json() {
        let coding = part_private("245", 6_000);
        let json = serde_json::to_string(&coding).unwrap();
        assert_eq!(
            json,
            r#"{"direction":"out","kind":"part_private","account":"245","gst":"standard","business_bp":6000}"#
        );
        for coding in every_coding() {
            let json = serde_json::to_string(&coding).unwrap();
            assert_eq!(serde_json::from_str::<Coding>(&json).unwrap(), coding);
        }
    }

    fn rule(
        id: &str,
        contains: &str,
        min: Option<&str>,
        max: Option<&str>,
        coding: Coding,
    ) -> Rule {
        Rule {
            id: id.into(),
            description_contains: contains.into(),
            min: min.map(m),
            max: max.map(m),
            coding,
        }
    }

    fn personal() -> Coding {
        Coding::Out(WithdrawalCoding::Personal)
    }

    #[test]
    fn rules_match_text_amount_and_direction() {
        let r = rule("a", "countdown", Some("10.00"), Some("200.00"), personal());
        assert!(r.matches("COUNTDOWN  PONSONBY", m("-45.10")));
        assert!(r.matches("Pos countdown ponsonby", m("-10.00")));
        assert!(r.matches("COUNTDOWN", m("-200.00")));
        assert!(!r.matches("COUNTDOWN", m("-200.01")));
        assert!(!r.matches("COUNTDOWN", m("-9.99")));
        assert!(!r.matches("COUNTDOWN", m("45.10")), "wrong direction");
        assert!(!r.matches("NEW WORLD", m("-45.10")));
        assert!(!r.matches("COUNTDOWN", Money::ZERO));
    }

    #[test]
    fn the_most_specific_rule_wins() {
        let rules = [
            rule("1", "", None, None, personal()),
            rule("2", "MOBIL", None, None, personal()),
            rule(
                "3",
                "MOBIL",
                Some("50.00"),
                None,
                part_private("225", 7_000),
            ),
            rule(
                "4",
                "MOBIL",
                Some("50.00"),
                Some("150.00"),
                part_private("225", 8_000),
            ),
            rule(
                "5",
                "MOBIL",
                Some("60.00"),
                Some("120.00"),
                part_private("225", 9_000),
            ),
            rule(
                "6",
                "MOBIL NEWMARKET",
                None,
                None,
                expense("225", GstCode::Standard),
            ),
        ];
        let best =
            |desc: &str, amount: &str| best_rule(&rules, desc, m(amount)).map(|r| r.id.as_str());
        assert_eq!(best("SOMETHING ELSE", "-5.00"), Some("1"));
        assert_eq!(best("MOBIL TAKAPUNA", "-20.00"), Some("2"));
        assert_eq!(best("MOBIL TAKAPUNA", "-200.00"), Some("3"));
        assert_eq!(best("MOBIL TAKAPUNA", "-140.00"), Some("4"));
        assert_eq!(best("MOBIL TAKAPUNA", "-100.00"), Some("5"));
        // Longer text beats any amount range.
        assert_eq!(best("MOBIL NEWMARKET", "-100.00"), Some("6"));
        // No rule here is for money in.
        assert_eq!(best("MOBIL TAKAPUNA", "100.00"), None);
    }

    #[test]
    fn ties_go_to_the_smallest_id_in_any_order() {
        let mut rules = vec![
            rule("b", "cafe", None, None, personal()),
            rule("a", "CAFE", None, None, expense("290", GstCode::Standard)),
            rule("c", "Cafe", None, None, personal()),
        ];
        for _ in 0..rules.len() {
            assert_eq!(best_rule(&rules, "THE CAFE", m("-8.00")).unwrap().id, "a");
            rules.rotate_left(1);
        }
    }

    #[test]
    fn validates_rules() {
        assert_eq!(
            rule("a", "X", Some("5.00"), Some("4.99"), personal()).validate(),
            Err(RuleError::MinAboveMax)
        );
        assert_eq!(
            rule("a", "X", Some("-1.00"), None, personal()).validate(),
            Err(RuleError::NegativeAmount)
        );
        assert_eq!(
            rule("a", "X", Some("5.00"), Some("5.00"), personal()).validate(),
            Ok(())
        );
    }

    fn any_gst() -> impl Strategy<Value = GstCode> {
        prop_oneof![
            Just(GstCode::Standard),
            Just(GstCode::Zero),
            Just(GstCode::Exempt),
            Just(GstCode::None),
        ]
    }

    proptest! {
        /// Whatever the coding, amount, share, date and confirmation, the lines sum to zero and
        /// touch the bank by exactly the line's amount.
        #[test]
        fn lines_always_sum_to_zero(
            cents in 1i64..1_000_000_000_000,
            pick in 0usize..64,
            gst in any_gst(),
            business_bp in 0u32..=10_000,
            registered in any::<bool>(),
            confirmed in any::<bool>(),
            day in 0u64..120,
        ) {
            let mut codings = every_coding();
            for c in &mut codings {
                match c {
                    Coding::In(DepositCoding::Income { gst: g, .. }) if gst != GstCode::None => *g = gst,
                    Coding::Out(
                        WithdrawalCoding::Expense { gst: g, .. }
                        | WithdrawalCoding::AssetPurchase { gst: g, .. },
                    ) => *g = gst,
                    Coding::Out(WithdrawalCoding::PartPrivate { gst: g, business_bp: b, .. }) => {
                        *g = gst;
                        *b = business_bp;
                    }
                    _ => {}
                }
            }
            let coding = &codings[pick % codings.len()];
            let signed = match coding.direction() {
                Direction::In => cents,
                Direction::Out => -cents,
            };
            let date = d("2025-07-01") + chrono::Days::new(day);
            let lines = post_with(
                &Money::from_cents(signed).to_string(),
                coding,
                confirmed,
                registered.then(|| d(REGISTERED)),
                &date.to_string(),
            ).unwrap();
            prop_assert_eq!(total(&lines), Money::ZERO);
            let on_bank: Money = lines.iter().filter(|(a, _)| a == "600.01").map(|(_, x)| *x).sum();
            prop_assert_eq!(on_bank, Money::from_cents(signed));
            prop_assert!(lines.iter().all(|(_, x)| !x.is_zero()));
        }
    }
}
