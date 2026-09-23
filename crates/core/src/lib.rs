//! Pure domain logic for acct: money, charts, ledger, mapping, depreciation and ReportDoc.
//!
//! This crate does no IO and reads no clock, randomness or environment, so the same inputs
//! always give byte-identical outputs.

pub mod money;

pub use money::{Money, ParseMoneyError};
