//! Bank reconciliation (M15, M18): does the ledger agree with what the bank says, and if not,
//! where and why.
//!
//! - [`account`]: one account at the end of the latest statement in a year, with the items that
//!   don't match (M15).
//! - [`checkpoints`]: every balance the bank states, the ledger at each, and the window where
//!   they part ways (M18).
//! - [`finding`]: what the suspects report (M18).
//! - [`diagnose`]: which findings explain the whole difference (M18).
//! - [`proof`]: Bank vs books on one date, for the card the owner sees after an upload (M18).
//!
//! Pure, like the rest of core: inputs are plain data the server loads, outputs are sorted and
//! hold no HashMaps, so the same books always give the same bytes.

pub mod account;
pub mod checkpoints;
pub mod diagnose;
pub mod finding;
pub mod proof;
pub mod suspects;

pub use account::{
    AccountFacts, AccountInputs, AccountReconciliation, GapItem, GapJournalFacts, GapJournalItem,
    LedgerJournal, ReconcileAccountKind, ReconcileStatus, UnmatchedJournal, UnmatchedLine,
    UnmatchedReason, movements, reconcile_account,
};
pub use checkpoints::{
    BalanceKind, BankLineFacts, Checkpoint, CheckpointSource, Compared, Movement, Shape,
    SourceSpan, StatementFacts, Walk, Window, checkpoints, walk,
};
pub use diagnose::{Diagnosis, diagnose};
pub use finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};
pub use proof::{CheckpointAt, Proof, ProofAt, ProofLine, ProofWindow, RECENT_LINES, proof};
