//! What a suspect finds (M18): the types the suspects (Agent 4) and the combiner (Agent 5) share.
//! Types only; the logic lives with each suspect.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::money::Money;

/// One possible reason for a difference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Finding {
    pub kind: FindingKind,
    /// How much of the difference (ledger less stated) this would explain, with the same sign.
    pub explains: Money,
    pub confidence: Confidence,
    /// What it's based on, by id.
    pub evidence: Vec<EvidenceRef>,
    /// A command that would fix it. A suspect only suggests it; nothing applies it but the owner.
    pub fix: Option<SuggestedFix>,
}

/// One kind per suspect, in PLAN.md's order (most common first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum FindingKind {
    /// A line uploaded twice: overlapping downloads, the same bank id in two files, or a line
    /// M10 flagged as a possible duplicate.
    Duplicate,
    /// Days no statement covers, or a download cut short.
    MissingLines,
    /// The opening balance entered differs from the first statement's.
    WrongOpeningBalance,
    /// A line or a whole file read with its sign the wrong way.
    SignReversed,
    /// A line marked as a duplicate that has nothing to duplicate.
    MarkedDuplicateButIsnt,
    /// A journal on the bank account with no statement line.
    EntryByHand,
    /// A line on the other side of a checkpoint in the ledger from where the file puts it.
    DateCutOff,
    /// A file uploaded to the wrong account.
    WrongAccount,
    /// An amount read wrong: cents as dollars, or a row where the file's running balance breaks.
    AmountReadWrong,
    /// Two digits swapped in an amount a person typed.
    TransposedDigits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Confidence {
    Likely,
    Possible,
}

/// Something a finding points at.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum EvidenceRef {
    BankLine {
        bank_line_id: String,
    },
    Journal {
        journal_id: String,
    },
    Statement {
        statement_id: String,
    },
    /// A run of days no statement covers. Gaps have no id, so it's named by its days.
    Gap {
        #[ts(type = "string")]
        start: NaiveDate,
        #[ts(type = "string")]
        end: NaiveDate,
    },
}

/// A command a finding suggests, with its payload. Previewed before anything changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SuggestedFix {
    /// `resolve_duplicate` with `is_duplicate: true`.
    MarkDuplicate {
        bank_line_id: String,
    },
    /// `resolve_duplicate` with `is_duplicate: false`.
    UnmarkDuplicate {
        bank_line_id: String,
    },
    SetOpeningBalance {
        bank_account_id: String,
        #[ts(type = "string")]
        date: NaiveDate,
        amount: Money,
    },
    /// Upload the statement covering these days.
    UploadMissing {
        bank_account_id: String,
        #[ts(type = "string")]
        start: NaiveDate,
        #[ts(type = "string")]
        end: NaiveDate,
    },
    RemoveStatement {
        statement_id: String,
    },
    /// `reverse_journal`: for a journal posted to the bank account by hand that no statement shows
    /// (Entries by hand).
    ReverseJournal {
        journal_id: String,
    },
}
