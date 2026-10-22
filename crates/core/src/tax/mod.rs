//! The tax engine: GST and income tax for sole traders, computed from ledger totals.
//!
//! Rates are versioned data here, chosen by date or income year, not practice settings. Amounts
//! are cents and rates basis points, with i128 for intermediate products, rounded once.

pub mod gst;
pub mod income_tax;
