//! Bank statement parsers (OFX, QIF, per-bank CSV) and TB import for acct.
//!
//! Parsers are pure: they take the file's text and return rows or row-numbered problems. The
//! server checks the rows against the client's chart and books.

pub mod tb;
