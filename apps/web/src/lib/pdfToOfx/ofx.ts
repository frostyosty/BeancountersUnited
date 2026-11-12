/**
 * Writes a statement as OFX 1.02 (SGML), the bank file format Xero, MYOB, most accounting apps and
 * our own importer read. It's built only from what's passed in (no clock, no randomness), so the
 * same statement always gives byte-identical files, and converting a PDF twice gives the same
 * transaction ids (`FITID`), which lets an importer skip lines it already has.
 */
import { formatPlainMoney } from "../money";

/** `cheque` and `savings` are bank accounts; `card` is a credit card. */
export type OfxAccountType = "cheque" | "savings" | "card";

export interface OfxLine {
  /** ISO date the bank processed it. */
  date: string;
  /** ISO date it was made, when the statement shows that as well. */
  madeOn?: string;
  description: string;
  /** Signed cents: positive is money in. */
  amount: number;
}

export interface OfxStatement {
  accountType: OfxAccountType;
  /** A NZ account number (`12-3456-0123456-00`), a card number (masked or not), or whatever the bank calls it. */
  account: string;
  /** ISO dates. */
  periodStart: string;
  periodEnd: string;
  /** Signed cents, as the lines; null when the statement doesn't give it. */
  closing: number | null;
  lines: readonly OfxLine[];
}

/** OFX 1.02 limits `NAME` to 32 characters; the rest of the description goes in `MEMO`. */
const NAME_LENGTH = 32;

/** Letters with accents or macrons as plain ASCII (`Māori` → `Maori`), since the file is declared US-ASCII. */
export function asciiText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The description split into `NAME` (up to 32 characters, ending at a word) and the rest for `MEMO`. */
export function splitName(description: string): { name: string; memo: string } {
  const text = asciiText(description) || "Transaction";
  if (text.length <= NAME_LENGTH) return { name: text, memo: "" };
  const cut = text.lastIndexOf(" ", NAME_LENGTH);
  const at = cut > 0 ? cut : NAME_LENGTH;
  return { name: text.slice(0, at).trim(), memo: text.slice(at).trim() };
}

function ofxDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/** 32-bit FNV-1a, as eight hex digits: short, and the same in every browser. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * An id for each line that stays the same each time the statement is converted: its date, and a
 * hash of the account, date, amount and description. Lines that are identical in all of those are
 * told apart by how many came before them.
 */
export function fitIds(account: string, lines: readonly OfxLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = `${account}|${l.date}|${l.amount}|${asciiText(l.description)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${ofxDate(l.date)}${fnv1a(`${key}|${n}`)}${n > 0 ? `-${n}` : ""}`;
  });
}

/** `BANKID`, `BRANCHID` and `ACCTID` for a bank account. A NZ number keeps all four parts in `ACCTID`. */
function bankAccount(account: string): string[] {
  const m = /^(\d{2})-(\d{4})-(\d{7,8})-(\d{2,3})$/.exec(account);
  const id = escape(asciiText(account));
  return m
    ? [`<BANKID>${m[1]}</BANKID>`, `<BRANCHID>${m[2]}</BRANCHID>`, `<ACCTID>${id}</ACCTID>`]
    : [`<BANKID>000000</BANKID>`, `<ACCTID>${id}</ACCTID>`];
}

export function buildOfx(s: OfxStatement): string {
  const card = s.accountType === "card";
  const account = asciiText(s.account);
  if (!account) throw new Error("An OFX file needs an account number.");
  const ids = fitIds(account, s.lines);
  const end = ofxDate(s.periodEnd);
  const status = ["<STATUS>", "<CODE>0</CODE>", "<SEVERITY>INFO</SEVERITY>", "</STATUS>"];

  const transactions = s.lines.flatMap((l, i) => {
    const { name, memo } = splitName(l.description);
    return [
      "<STMTTRN>",
      `<TRNTYPE>${l.amount < 0 ? "DEBIT" : "CREDIT"}</TRNTYPE>`,
      `<DTPOSTED>${ofxDate(l.date)}</DTPOSTED>`,
      ...(l.madeOn ? [`<DTUSER>${ofxDate(l.madeOn)}</DTUSER>`] : []),
      `<TRNAMT>${formatPlainMoney(l.amount)}</TRNAMT>`,
      `<FITID>${ids[i]}</FITID>`,
      `<NAME>${escape(name)}</NAME>`,
      ...(memo ? [`<MEMO>${escape(memo)}</MEMO>`] : []),
      "</STMTTRN>",
    ];
  });

  const statement = [
    card ? "<CCSTMTRS>" : "<STMTRS>",
    "<CURDEF>NZD</CURDEF>",
    ...(card
      ? ["<CCACCTFROM>", `<ACCTID>${escape(account)}</ACCTID>`, "</CCACCTFROM>"]
      : [
          "<BANKACCTFROM>",
          ...bankAccount(account),
          `<ACCTTYPE>${s.accountType === "savings" ? "SAVINGS" : "CHECKING"}</ACCTTYPE>`,
          "</BANKACCTFROM>",
        ]),
    "<BANKTRANLIST>",
    `<DTSTART>${ofxDate(s.periodStart)}</DTSTART>`,
    `<DTEND>${end}</DTEND>`,
    ...transactions,
    "</BANKTRANLIST>",
    ...(s.closing === null
      ? []
      : ["<LEDGERBAL>", `<BALAMT>${formatPlainMoney(s.closing)}</BALAMT>`, `<DTASOF>${end}</DTASOF>`, "</LEDGERBAL>"]),
    card ? "</CCSTMTRS>" : "</STMTRS>",
  ];

  const body = [
    "<OFX>",
    "<SIGNONMSGSRSV1>",
    "<SONRS>",
    ...status,
    `<DTSERVER>${end}</DTSERVER>`,
    "<LANGUAGE>ENG</LANGUAGE>",
    "</SONRS>",
    "</SIGNONMSGSRSV1>",
    card ? "<CREDITCARDMSGSRSV1>" : "<BANKMSGSRSV1>",
    card ? "<CCSTMTTRNRS>" : "<STMTTRNRS>",
    "<TRNUID>1</TRNUID>",
    ...status,
    ...statement,
    card ? "</CCSTMTTRNRS>" : "</STMTTRNRS>",
    card ? "</CREDITCARDMSGSRSV1>" : "</BANKMSGSRSV1>",
    "</OFX>",
  ];

  const header = [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:1252",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
  ];
  return `${header.join("\r\n")}\r\n\r\n${body.join("\r\n")}\r\n`;
}

/** A file name for the statement: `statement-12-3456-0123456-00-2026-03-31.ofx`. */
export function ofxFileName(account: string, periodEnd: string): string {
  const safe = asciiText(account)
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `statement-${safe ? `${safe}-` : ""}${periodEnd}.ofx`;
}
