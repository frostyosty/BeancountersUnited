//! Pure domain logic for acct: money, charts, ledger, mapping, depreciation and ReportDoc.
//!
//! This crate does no IO and reads no clock, randomness or environment, so the same inputs
//! always give byte-identical outputs.

pub mod analysis;
pub mod bank;
pub mod chart;
pub mod coding;
pub mod depreciation;
pub mod finalise;
pub mod gl;
pub mod layout;
pub mod ledger;
pub mod mapping;
pub mod money;
pub mod notes;
pub mod reportdoc;
pub mod tax;
pub mod template;

pub use chart::{Account, AccountCode, AccountCodeError, AccountType, Chart, ChartError, GstCode};
pub use depreciation::{
    Asset, AssetAccounts, AssetError, AssetSchedule, AssetYear, DepreciationSettings, Disposal,
    DisposalYear, Method, OpeningBalance, PartYear, RateSource, ReconciliationLine, RegisterAsset,
    ScheduleBlock, ScheduleClass, ScheduleRow, ScheduleRowKey, ScheduleRowStyle, SlBasis,
    YearJournals, asset_years, build_asset_schedule, reconcile, year_journals,
};
pub use layout::{RowChange, RowSummary, row_changes};
pub use ledger::{
    ClientYear, ClientYearError, Journal, JournalError, JournalLine, RolloverError, TbLine,
    TrialBalance, rollover,
};
pub use mapping::{Mapping, MappingError, MappingRange};
pub use money::{Money, ParseMoneyError};
pub use reportdoc::{
    BuildError, Column, Comparatives, Period, Prior, ReportDoc, ReportInput, ReportRow,
    ReportStatement, ReportWarning, RowAccount, RowRounding, RowStyle, build_report,
};
pub use template::{
    EqualityCheck, LineKey, LineKeyError, Node, Presentation, Statement, Template, TemplateError,
};
