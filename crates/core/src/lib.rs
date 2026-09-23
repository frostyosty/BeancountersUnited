//! Pure domain logic for acct: money, charts, ledger, mapping, depreciation and ReportDoc.
//!
//! This crate does no IO and reads no clock, randomness or environment, so the same inputs
//! always give byte-identical outputs.

pub mod chart;
pub mod ledger;
pub mod money;

pub use chart::{Account, AccountCode, AccountCodeError, AccountType, Chart, ChartError};
pub use ledger::{
    ClientYear, ClientYearError, Journal, JournalError, JournalLine, RolloverError, TbLine,
    TrialBalance, rollover,
};
pub use money::{Money, ParseMoneyError};
