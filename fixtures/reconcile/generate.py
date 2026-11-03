"""Builds fixtures/reconcile/ (M18): the clean set and one variant per suspect.

Run from anywhere: `python fixtures/reconcile/generate.py`. It rewrites every file it owns in this
directory, and the output is the same on every run (no clock, no randomness). Everything here is
synthetic (CLAUDE.md hard rule 1): the business, the people, the merchants, the banks and the
account numbers are invented. Money is integer cents throughout (hard rule 4).

The expected window in each fault.toml comes from simulating the ledger the way the server builds
it: M10's exact duplicate key, the opening balance taken from the first statement that reaches the
start date unless the owner typed one first, and a line resolved as a duplicate posting nothing.
"""

from __future__ import annotations

import calendar
import shutil
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent

BUSINESS = "Ferncliff Joinery"
OWNER = "J Pettigrew"
START = date(2025, 4, 1)
BALANCE_DATE = date(2026, 3, 31)

CHEQUE_NUMBER = "99-5501-0000612-00"
CARD_MASK = "XXXX-XXXX-XXXX-5290"
CHEQUE_OPENING = 326485
CARD_OPENING = -31860

MONTHS = [(2025, m) for m in range(4, 13)] + [(2026, m) for m in range(1, 4)]


# ---------------------------------------------------------------------------------------------
# Transactions


@dataclass(frozen=True)
class Txn:
    date: date
    cents: int
    name: str
    memo: str | None = None
    fitid: str | None = None
    # The day the purchase was made; the card posts it a day later. Used only by 01b.
    tdate: date | None = None

    def description(self) -> str:
        """The description as the parsers normalise it."""
        return " ".join(f"{self.name} {self.memo or ''}".upper().split())


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    c = abs(cents)
    return f"{sign}{c // 100}.{c % 100:02d}"


def unsigned(cents: int) -> str:
    return money(abs(cents))


def dmy(d: date) -> str:
    return d.strftime("%d/%m/%Y")


def ymd(d: date) -> str:
    return d.strftime("%Y%m%d")


def last_day(y: int, m: int) -> date:
    return date(y, m, calendar.monthrange(y, m)[1])


def card_txns() -> list[Txn]:
    """Every card transaction in the year, in posting order. Payments clear last month's balance."""
    out: list[Txn] = []
    balance = CARD_OPENING
    for i, (y, mo) in enumerate(MONTHS):
        owed_at_start = -balance
        month: list[Txn] = []

        def add(day: int, cents: int, name: str, memo: str | None, purchase: bool = True) -> None:
            d = date(y, mo, day)
            month.append(
                Txn(d, cents, name, memo, tdate=d - timedelta(days=1) if purchase else d)
            )

        add(2, -(4890 + 310 * i), "WAXWING SUPPLIES LTD", "AUCKLAND")
        add(7, -2375, "CLOUDFORGE HOSTING", "USD 14.20")
        add(7, -59, "OVERSEAS TRANSACTION FEE", None, purchase=False)
        add(11, -(7135 + 620 * (i % 3)), "KAURI PETROL", "NELSON")
        add(16, -(12900 + 450 * i), "GLIMMER WICK CO", "ONLINE")
        if (y, mo) == (2025, 9):
            # Two identical purchases on one day: both are real.
            add(19, -720, "PIKORUA CAFE", "WELLINGTON")
            add(19, -720, "PIKORUA CAFE", "WELLINGTON")
        add(24, owed_at_start, "PAYMENT RECEIVED", "THANK YOU", purchase=False)
        add(26, -(3800 + 600 * (i % 2)), "BRIGHTPOST COURIERS", "ONLINE")
        if (y, mo) == (2025, 9):
            add(27, -1140, "PIKORUA CAFE", "WELLINGTON")
        add(28, -(5620 + 270 * i), "GREENBARROW GROCERS", "WELLINGTON")
        if (y, mo) == (2025, 9):
            # Posted late on 28 Sep, after the July-September QIF was downloaded.
            add(28, -6480, "WOODMILL HARDWARE", "EFTPOS")
            add(30, -14900, "LANTERN HOST WEB", "ANNUAL PLAN")
        month.sort(key=lambda t: t.date)
        seq: dict[date, int] = {}
        for t in month:
            seq[t.date] = seq.get(t.date, 0) + 1
            out.append(replace(t, fitid=f"HLV{ymd(t.date)}{seq[t.date]:03d}"))
            balance += t.cents
    return out


def cheque_txns(card: list[Txn]) -> list[Txn]:
    """Every cheque account transaction in the year: at most one a day, so a running balance is
    also the balance at the end of its day."""
    payments = {t.date: t.cents for t in card if t.name == "PAYMENT RECEIVED"}
    out: list[Txn] = []
    for i, (y, mo) in enumerate(MONTHS):

        def add(day: int, cents: int, text: str) -> None:
            out.append(Txn(date(y, mo, day), cents, text))

        add(3, 124000 + 3715 * i, "PAYBLOOM PAYOUT ONLINE SALES")
        add(6, -(18640 + 1130 * i), "WOODMILL HARDWARE")
        add(9, -2499, "LANTERN HOST WEB")
        add(12, 86000 + 2340 * i, f"HOLLOWAY GIFTS LTD INV {612 + i:04d}")
        add(15, -(9210 + 835 * (i % 4)), "GRIDLINE POWER")
        add(18, -3999, "TELEWAVE MOBILE")
        add(21, -(41275 + 960 * i), "TIMBERLINE MERCHANTS")
        add(24, -payments[date(y, mo, 24)], "PAYMENT TO HARBOURLIGHT VISA 5290")
        add(27, -7850, "FARO INSURANCE, PREMIUM")
        add(28, -60000, "DRAWINGS TO OWN ACCOUNT")
    return out


def between(txns: list[Txn], first: date, last: date) -> list[Txn]:
    return [t for t in txns if first <= t.date <= last]


def balance_before(opening: int, txns: list[Txn], d: date) -> int:
    """The balance at the start of `d`."""
    return opening + sum(t.cents for t in txns if t.date < d)


def balance_at_end(opening: int, txns: list[Txn], d: date) -> int:
    return opening + sum(t.cents for t in txns if t.date <= d)


# ---------------------------------------------------------------------------------------------
# File writers. Each returns (text, checkpoints, line rows), where a checkpoint is
# (date, phase, stated cents, label): phase 0 is the start of the day (an opening balance), 1 the
# end of the day (a closing or running balance).


@dataclass
class File:
    name: str
    account: str
    text: str
    checkpoints: list[tuple[date, int, int, str]]
    # (txn as the parser reads it, the file line where its record starts)
    lines: list[tuple[Txn, int]]
    # The first day the file covers: its stated period, or its opening entry.
    start: date | None = None
    # The last day of its stated period, where it states one.
    end: date | None = None
    # Each row's running balance, where the file gives one: {file line: stated cents}.
    running: dict[int, int] = field(default_factory=dict)


def kowhai_csv(
    name: str,
    period: tuple[date, date],
    opening: int,
    txns: list[Txn],
    *,
    swap_columns: bool = False,
    misprint: dict[date, str] | None = None,
) -> File:
    """Kowhai Co-operative Bank CSV (layout A): opening, closing and a running balance per row.
    `swap_columns` writes money out under Credit and money in under Debit (04). `misprint` writes
    a row's amount cell as given instead of the true figure (09). Balances are always the bank's
    true ones."""
    rows = [
        "Kowhai Co-operative Bank - Account statement (SYNTHETIC SAMPLE)",
        f"Account name,{OWNER.upper()} T/A {BUSINESS.upper()}",
        f"Account number,{CHEQUE_NUMBER}",
        f"Statement period,{dmy(period[0])},{dmy(period[1])}",
        f"Opening balance,{money(opening)}",
        "Closing balance,CLOSING",
        "",
        "Date,Description,Debit,Credit,Balance",
    ]
    checkpoints = [(period[0], 0, opening, f"{name} opening balance")]
    lines: list[tuple[Txn, int]] = []
    balances: dict[int, int] = {}
    running = opening
    for t in txns:
        running += t.cents
        text = f'"{t.name}"' if "," in t.name else t.name
        cell = (misprint or {}).get(t.date, unsigned(t.cents))
        out_col = t.cents < 0
        if swap_columns:
            out_col = not out_col
        debit, credit = (cell, "") if out_col else ("", cell)
        rows.append(f"{dmy(t.date)},{text},{debit},{credit},{money(running)}")
        row = len(rows)
        read_cents = (-1 if out_col else 1) * int(cell.replace(".", "")) * (
            1 if "." in cell else 100
        )
        lines.append((replace(t, cents=read_cents), row))
        balances[row] = running
        checkpoints.append((t.date, 1, running, running_label(name, row)))
    rows[5] = f"Closing balance,{money(running)}"
    rows.append("End of statement")
    checkpoints.append((period[1], 1, running, f"{name} closing balance"))
    return File(
        name, "cheque", "\n".join(rows) + "\n", checkpoints, lines, period[0], period[1], balances
    )


def running_label(name: str, row: int) -> str:
    return f"{name} row {row} running balance"


def qif(
    name: str,
    account: str,
    account_line: str,
    kind: str,
    opening: tuple[date, int],
    txns: list[Txn],
    *,
    use_tdate: bool = False,
    title_case: bool = True,
) -> File:
    """QIF with an `Opening Balance` entry (the balance at the start of its date). No closing."""
    out = ["!Account", f"N{account_line}", f"T{kind}", "^", f"!Type:{kind}"]
    out += [
        f"D{dmy(opening[0])}",
        f"T{money(opening[1])}",
        "POpening Balance",
        f"L[{account_line}]",
        "^",
    ]
    lines: list[tuple[Txn, int]] = []
    for t in txns:
        d = t.tdate if use_tdate and t.tdate else t.date
        row = len(out) + 1
        out.append(f"D{dmy(d)}")
        out.append(f"T{money(t.cents)}")
        payee = t.name.title() if title_case else t.name
        out.append(f"P{payee}")
        if t.memo:
            out.append(f"M{t.memo.title() if title_case else t.memo}")
        out.append("^")
        lines.append((replace(t, date=d, fitid=None), row))
    checkpoints = [(opening[0], 0, opening[1], f"{name} opening balance")]
    return File(name, account, "\n".join(out) + "\n", checkpoints, lines, opening[0])


def ofx_card_xml(
    name: str, period: tuple[date, date], closing: int, txns: list[Txn], *, memo_first: bool = False
) -> File:
    """OFX 2.2 (XML) card statement: closing balance only. `memo_first` is the bank's other export,
    which puts the merchant in MEMO and the transaction type in NAME (01a)."""
    out = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
        "<OFX>",
        "  <SIGNONMSGSRSV1>",
        "    <SONRS>",
        "      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
        f"      <DTSERVER>{ymd(period[1] + timedelta(days=1))}000000</DTSERVER>",
        "      <LANGUAGE>ENG</LANGUAGE>",
        "      <FI><ORG>Harbourlight Bank (SYNTHETIC)</ORG><FID>0099</FID></FI>",
        "    </SONRS>",
        "  </SIGNONMSGSRSV1>",
        "  <CREDITCARDMSGSRSV1>",
        "    <CCSTMTTRNRS>",
        "      <TRNUID>0</TRNUID>",
        "      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
        "      <CCSTMTRS>",
        "        <CURDEF>NZD</CURDEF>",
        "        <CCACCTFROM>",
        f"          <ACCTID>XXXXXXXXXXXX{CARD_MASK[-4:]}</ACCTID>",
        "        </CCACCTFROM>",
        "        <BANKTRANLIST>",
        f"          <DTSTART>{ymd(period[0])}</DTSTART>",
        f"          <DTEND>{ymd(period[1])}</DTEND>",
    ]
    lines: list[tuple[Txn, int]] = []
    for t in txns:
        row = len(out) + 1
        kind = trntype(t)
        out.append("          <STMTTRN>")
        out.append(f"            <TRNTYPE>{kind}</TRNTYPE>")
        out.append(f"            <DTPOSTED>{ymd(t.date)}</DTPOSTED>")
        out.append(f"            <TRNAMT>{money(t.cents)}</TRNAMT>")
        out.append(f"            <FITID>{t.fitid}</FITID>")
        if memo_first:
            label = "PAYMENT" if t.cents > 0 else "CARD PURCHASE"
            merchant = " ".join(filter(None, [t.name, t.memo]))
            out.append(f"            <NAME>{label}</NAME>")
            out.append(f"            <MEMO>{merchant}</MEMO>")
            read = replace(t, name=label, memo=merchant)
        else:
            out.append(f"            <NAME>{t.name}</NAME>")
            if t.memo:
                out.append(f"            <MEMO>{t.memo}</MEMO>")
            read = t
        out.append("          </STMTTRN>")
        lines.append((read, row))
    out += [
        "        </BANKTRANLIST>",
        "        <LEDGERBAL>",
        f"          <BALAMT>{money(closing)}</BALAMT>",
        f"          <DTASOF>{ymd(period[1])}</DTASOF>",
        "        </LEDGERBAL>",
        "      </CCSTMTRS>",
        "    </CCSTMTTRNRS>",
        "  </CREDITCARDMSGSRSV1>",
        "</OFX>",
    ]
    checkpoints = [(period[1], 1, closing, f"{name} closing balance (LEDGERBAL)")]
    return File(name, "card", "\n".join(out) + "\n", checkpoints, lines, period[0], period[1])


def ofx_card_sgml(name: str, period: tuple[date, date], closing: int, txns: list[Txn]) -> File:
    """OFX 1.02 (SGML, leaves unclosed) card statement: closing balance only."""
    out = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "VERSION:102",
        "SECURITY:NONE",
        "ENCODING:USASCII",
        "CHARSET:1252",
        "COMPRESSION:NONE",
        "OLDFILEUID:NONE",
        "NEWFILEUID:NONE",
        "",
        "<OFX>",
        "<SIGNONMSGSRSV1>",
        "<SONRS>",
        "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
        f"<DTSERVER>{ymd(period[1] + timedelta(days=1))}000000",
        "<LANGUAGE>ENG",
        "<FI><ORG>Harbourlight Bank (SYNTHETIC)<FID>0099</FI>",
        "</SONRS>",
        "</SIGNONMSGSRSV1>",
        "<CREDITCARDMSGSRSV1>",
        "<CCSTMTTRNRS>",
        "<TRNUID>0",
        "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
        "<CCSTMTRS>",
        "<CURDEF>NZD",
        "<CCACCTFROM>",
        f"<ACCTID>XXXXXXXXXXXX{CARD_MASK[-4:]}",
        "</CCACCTFROM>",
        "<BANKTRANLIST>",
        f"<DTSTART>{ymd(period[0])}",
        f"<DTEND>{ymd(period[1])}",
    ]
    lines: list[tuple[Txn, int]] = []
    for t in txns:
        row = len(out) + 1
        out.append("<STMTTRN>")
        out.append(f"<TRNTYPE>{trntype(t)}")
        out.append(f"<DTPOSTED>{ymd(t.date)}")
        out.append(f"<TRNAMT>{money(t.cents)}")
        out.append(f"<FITID>{t.fitid}")
        out.append(f"<NAME>{t.name}")
        if t.memo:
            out.append(f"<MEMO>{t.memo}")
        out.append("</STMTTRN>")
        lines.append((t, row))
    out += [
        "</BANKTRANLIST>",
        "<LEDGERBAL>",
        f"<BALAMT>{money(closing)}",
        f"<DTASOF>{ymd(period[1])}235959",
        "</LEDGERBAL>",
        "</CCSTMTRS>",
        "</CCSTMTTRNRS>",
        "</CREDITCARDMSGSRSV1>",
        "</OFX>",
    ]
    checkpoints = [(period[1], 1, closing, f"{name} closing balance (LEDGERBAL)")]
    return File(name, "card", "\n".join(out) + "\n", checkpoints, lines, period[0], period[1])


def trntype(t: Txn) -> str:
    if t.cents > 0:
        return "CREDIT"
    if "FEE" in t.name:
        return "FEE"
    return "DEBIT"


# ---------------------------------------------------------------------------------------------
# The clean set


CARD = card_txns()
CHEQUE = cheque_txns(CARD)


def cheque_month(i: int, **kw) -> File:
    y, mo = MONTHS[i]
    first, last = date(y, mo, 1), last_day(y, mo)
    return kowhai_csv(
        f"kowhai-cheque-{y}-{mo:02d}.csv",
        (first, last),
        balance_before(CHEQUE_OPENING, CHEQUE, first),
        between(CHEQUE, first, last),
        **kw,
    )


def card_q1(txns: list[Txn] | None = None) -> File:
    p = (date(2025, 4, 1), date(2025, 6, 30))
    return ofx_card_xml(
        "visa-2025-04-01_06-30.ofx",
        p,
        balance_at_end(CARD_OPENING, CARD, p[1]),
        txns if txns is not None else between(CARD, *p),
    )


WOODMILL_LATE = next(t for t in CARD if t.name == "WOODMILL HARDWARE")


def card_q2() -> File:
    first, last = date(2025, 7, 1), date(2025, 9, 28)
    txns = [t for t in between(CARD, first, last) if t != WOODMILL_LATE]
    return qif(
        "visa-2025-07-01_09-28.qif",
        "card",
        f"Harbourlight Visa {CARD_MASK}",
        "CCard",
        (first, balance_before(CARD_OPENING, CARD, first)),
        txns,
    )


def card_q3() -> File:
    first, last = date(2025, 9, 27), date(2025, 12, 31)
    return qif(
        "visa-2025-09-27_12-31.qif",
        "card",
        f"Harbourlight Visa {CARD_MASK}",
        "CCard",
        (first, balance_before(CARD_OPENING, CARD, first)),
        between(CARD, first, last),
    )


def card_q4(txns: list[Txn] | None = None) -> File:
    p = (date(2026, 1, 1), date(2026, 3, 31))
    return ofx_card_sgml(
        "visa-2026-01-01_03-31.ofx",
        p,
        balance_at_end(CARD_OPENING, CARD, p[1]),
        txns if txns is not None else between(CARD, *p),
    )


@dataclass
class Upload:
    file: File
    # True when the owner picks the account (the upload sends bank_account_id), rather than the
    # file's own account number picking it.
    chosen: bool = False


@dataclass
class Cmd:
    """A command to replay, in TOML form, with when to run it and how it changes the simulated
    ledger."""

    when: str  # "before_uploads" | "after_uploads"
    toml: str
    fault: bool = False
    typed_opening: tuple[str, int] | None = None
    resolve_dup: tuple[Txn, bool] | None = None  # (line as stored, is_duplicate)
    hand: tuple[str, date, int] | None = None  # (account, date, cents on the bank account)


def clean_uploads() -> list[Upload]:
    # Each cheque month after the card statement it pays, in date order.
    ups = [Upload(cheque_month(i)) for i in range(3)]
    ups.insert(3, Upload(card_q1()))
    ups += [Upload(cheque_month(i)) for i in range(3, 6)]
    ups.append(Upload(card_q2()))
    ups.append(Upload(card_q3()))
    ups += [Upload(cheque_month(i)) for i in range(6, 12)]
    ups.append(Upload(card_q4()))
    return ups


def line_ref(t: Txn, file: File) -> str:
    row = next(r for (lt, r) in file.lines if lt == t)
    return (
        f'{{ file = "{file.name}", row = {row}, date = {t.date.isoformat()}, '
        f'amount_cents = {t.cents}, description = "{t.description()}" }}'
    )


def woodmill_stored(card3: File) -> Txn:
    return next(lt for (lt, _) in card3.lines if lt.name.upper() == "WOODMILL HARDWARE")


def clean_commands(uploads: list[Upload], *, woodmill_is_duplicate: bool = False) -> list[Cmd]:
    card3 = next(u.file for u in uploads if u.file.name == "visa-2025-09-27_12-31.qif")
    w = woodmill_stored(card3)
    return [
        Cmd(
            "after_uploads",
            "kind = \"ResolveDuplicate\"\n"
            f"line = {line_ref(w, card3)}\n"
            f"is_duplicate = {'true' if woodmill_is_duplicate else 'false'}",
            fault=woodmill_is_duplicate,
            resolve_dup=(w, woodmill_is_duplicate),
        )
    ]


# ---------------------------------------------------------------------------------------------
# Simulating the ledger and its checkpoints


@dataclass
class Sim:
    checkpoints: dict[str, list[tuple[date, int, int, str, int]]]  # + ledger balance
    closing: dict[str, int]  # ledger at the end of BALANCE_DATE
    lines_added: dict[str, int] = field(default_factory=dict)


@dataclass
class Cover:
    """The days a stored statement covers and the balances M10 stores for it (`coverage()` in
    crates/server/src/business.rs): the stated period widened to take in every line, and each end's
    balance as stated or worked out from the lines."""

    start: date
    end: date
    opening: int | None
    closing: int | None


def stated(f: File, which: str) -> tuple[date, int] | None:
    """The file's stated opening or closing balance, with the date it's stated for."""
    for d, _, st, label in f.checkpoints:
        if which == "opening" and label.endswith("opening balance"):
            return d, st
        if which == "closing" and "closing balance" in label:
            return d, st
    return None


def coverage(f: File) -> Cover:
    dates = [t.date for t, _ in f.lines]
    op, cl = stated(f, "opening"), stated(f, "closing")
    start = min([f.start or (op[0] if op else dates[0]), *dates])
    end = max([f.end or (cl[0] if cl else dates[-1]), *dates])
    net = sum(t.cents for t, _ in f.lines)
    opening = op[1] if op else (cl[1] - net if cl else None)
    closing = cl[1] if cl else (opening + net if opening is not None else None)
    return Cover(start, end, opening, closing)


def kept_running(f: File, stored: list[tuple[Txn, int]]) -> set[str]:
    """The labels of the running balances core keeps as checkpoints (the module docs of
    crates/core/src/reconcile/checkpoints.rs): of the stored lines with a balance, in file order,
    the last of each date, and only when the file confirms it's the end of that day. The next
    such line's balance less its amount must equal it; for the last, the closing balance must, and
    it can't be on the closing balance's own date (which says the same thing)."""
    with_balance = [(t, f.running[row], row) for t, row in stored if row in f.running]
    cl = stated(f, "closing")
    end = cl[0] if cl else coverage(f).end
    kept = set()
    for i, (t, bal, row) in enumerate(with_balance):
        nxt = with_balance[i + 1] if i + 1 < len(with_balance) else None
        if nxt and nxt[0].date == t.date:
            continue
        if nxt:
            confirmed = nxt[1] - nxt[0].cents == bal
        else:
            confirmed = t.date != end and (cl is None or cl[1] == bal)
        if confirmed:
            kept.add(running_label(f.name, row))
    return kept


def gaps(opening: int | None, covers: list[Cover]) -> list[tuple[date, date, int | None]]:
    """Runs of days no statement covers from START, with the change across each when the
    balances either side are known (`acct_core::bank::gaps`)."""
    out = []
    cursor, balance = START, opening
    for c in sorted((c for c in covers if c.end >= START), key=lambda c: (c.start, c.end)):
        if c.start > cursor:
            change = c.opening - balance if balance is not None and c.opening is not None else None
            out.append((cursor, c.start - timedelta(days=1), change))
        if c.end >= cursor:
            cursor, balance = c.end + timedelta(days=1), c.closing
    return out


def simulate(uploads: list[Upload], commands: list[Cmd]) -> Sim:
    ledger: dict[str, list[Txn]] = {"cheque": [], "card": []}
    opening: dict[str, int | None] = {"cheque": None, "card": None}
    keys: dict[str, set] = {"cheque": set(), "card": set()}
    cps: dict[str, list[tuple[date, int, int, str]]] = {"cheque": [], "card": []}
    covers: dict[str, list[Cover]] = {"cheque": [], "card": []}
    for c in commands:
        if c.when == "before_uploads" and c.typed_opening:
            acct, cents = c.typed_opening
            opening[acct] = cents
    added: dict[str, int] = {}
    for up in uploads:
        f = up.file
        acct = f.account
        cover = coverage(f)
        occ: dict[tuple, int] = {}
        stored: list[tuple[Txn, int]] = []
        for t, row in f.lines:
            k = (t.date, t.cents, t.description())
            occ[k] = occ.get(k, 0) + 1
            key = (*k, occ[k])
            if t.date < START or key in keys[acct]:
                continue
            keys[acct].add(key)
            ledger[acct].append(t)
            stored.append((t, row))
        added[f.name] = len(stored)
        inside_earlier = any(c.start <= cover.start and cover.end <= c.end for c in covers[acct])
        if not stored and inside_earlier:
            continue  # M10 stores no statement for it
        covers[acct].append(cover)
        running = {running_label(f.name, row) for row in f.running}
        keep = kept_running(f, stored)
        cps[acct] += [c for c in f.checkpoints if c[3] not in running or c[3] in keep]
        if opening[acct] is None and cover.start <= START and cover.opening is not None:
            before = sum(t.cents for t, _ in f.lines if t.date < START)
            opening[acct] = cover.opening + before
    # Gap journals: the change across each gap with known balances either side, on its last day,
    # unless it's zero.
    for acct in ledger:
        for start, end, change in gaps(opening[acct], covers[acct]):
            if change:
                ledger[acct].append(Txn(end, change, f"NO STATEMENT FROM {start} TO {end}"))
    for c in commands:
        if c.resolve_dup and c.resolve_dup[1]:
            ledger["card"].remove(c.resolve_dup[0])
        if c.hand:
            acct, d, cents = c.hand
            ledger[acct].append(Txn(d, cents, "HAND JOURNAL"))
    out: dict[str, list] = {}
    closing: dict[str, int] = {}
    for acct in ledger:
        op = opening[acct] or 0
        rows = []
        for d, ph, stated, label in sorted(cps[acct], key=lambda c: (c[0], c[1])):
            led = balance_before(op, ledger[acct], d) if ph == 0 else balance_at_end(
                op, ledger[acct], d
            )
            rows.append((d, ph, stated, label, led))
        out[acct] = rows
        closing[acct] = balance_at_end(op, ledger[acct], BALANCE_DATE)
    return Sim(out, closing, added)


def window(rows: list[tuple[date, int, int, str, int]]) -> dict:
    diffs = [led - st for (_, _, st, _, led) in rows]
    first = next((i for i, d in enumerate(diffs) if d != 0), None)
    if first is None:
        return {"first_differs": None}
    last = first - 1 if first > 0 else None
    if all(d == diffs[0] for d in diffs):
        shape = "constant"
    elif all(d == 0 for d in diffs[:first]) and all(d == diffs[first] for d in diffs[first:]):
        shape = "jump"
    else:
        shape = "drifting"
    return {
        "last_agrees": rows[last] if last is not None else None,
        "first_differs": rows[first],
        "shape": shape,
        "end": diffs[-1],
    }


def cp_toml(cp) -> str:
    d, ph, stated, label, led = cp
    when = "start" if ph == 0 else "end"
    return (
        f'{{ date = {d.isoformat()}, of_day = "{when}", balance = "{label}", '
        f"stated_cents = {stated}, ledger_cents = {led} }}"
    )


# ---------------------------------------------------------------------------------------------
# Writing a fixture


def write_files(dir: Path, uploads: list[Upload]) -> None:
    if dir.exists():
        shutil.rmtree(dir)
    dir.mkdir(parents=True)
    for up in uploads:
        (dir / up.file.name).write_bytes(up.file.text.encode("utf-8"))


def uploads_toml(uploads: list[Upload], sim: Sim) -> str:
    out = []
    for up in uploads:
        out.append("[[uploads]]")
        out.append(f'file = "{up.file.name}"')
        out.append(f'account = "{up.file.account}"')
        out.append(f"choose_account = {'true' if up.chosen else 'false'}")
        out.append(f"lines_in_file = {len(up.file.lines)}")
        out.append(f"lines_added = {sim.lines_added[up.file.name]}")
        out.append("")
    return "\n".join(out)


def commands_toml(commands: list[Cmd]) -> str:
    out = []
    for c in commands:
        out.append("[[commands]]")
        out.append(f'when = "{c.when}"')
        out.append(f"fault = {'true' if c.fault else 'false'}")
        out.append(c.toml)
        out.append("")
    return "\n".join(out)


HEADER = """# Generated by fixtures/reconcile/generate.py; edit that, not this file.
# Synthetic data only (CLAUDE.md hard rule 1). Money is integer cents; a difference is the
# ledger less the bank's stated balance, as acct_core::reconcile reports it.
"""


def write_clean() -> tuple[list[Upload], Sim]:
    ups = clean_uploads()
    cmds = clean_commands(ups)
    sim = simulate(ups, cmds)
    for acct, rows in sim.checkpoints.items():
        bad = [r for r in rows if r[2] != r[4]]
        assert not bad, f"clean {acct} disagrees: {bad[:3]}"
    dir = HERE / "clean"
    write_files(dir, ups)
    cheque_close = balance_at_end(CHEQUE_OPENING, CHEQUE, BALANCE_DATE)
    card_close = balance_at_end(CARD_OPENING, CARD, BALANCE_DATE)
    assert sim.closing == {"cheque": cheque_close, "card": card_close}
    n = {a: len(r) for a, r in sim.checkpoints.items()}
    text = f"""{HEADER}
# The clean set: every checkpoint agrees ({n['cheque']} on the cheque account, {n['card']} on the card).
# Variants take their setup from here; their own fault.toml lists their uploads and commands.

[business]
name = "{BUSINESS}"
owner = "{OWNER}"
entity = "sole_trader"
start_date = {START.isoformat()}
gst_registered = false
balance_date = {BALANCE_DATE.isoformat()}

[[accounts]]
key = "cheque"
kind = "bank"
command = "AddBankAccount"
name = "Kowhai cheque"
number = "{CHEQUE_NUMBER}"
code = "600.01"
opening_cents = {CHEQUE_OPENING}

[[accounts]]
key = "card"
kind = "credit_card"
command = "AddCardAccount"
name = "Harbourlight Visa"
number = "{CARD_MASK}"
code = "850.01"
opening_cents = {CARD_OPENING}

[expected]
# The ledger and the bank both say these at the end of the balance date.
cheque_cents = {cheque_close}
card_cents = {card_close}
cheque_lines = {len(CHEQUE)}
card_lines = {len(CARD)}

{uploads_toml(ups, sim)}
{commands_toml(cmds)}"""
    (dir / "fixture.toml").write_text(text.rstrip() + "\n", encoding="utf-8")
    return ups, sim


@dataclass
class Fault:
    suspect: str
    account: str
    explains: int
    summary: str
    evidence: list[str]
    fix: str
    confidence: str = "likely"


def write_variant(
    dir_name: str,
    title: str,
    uploads: list[Upload],
    commands: list[Cmd],
    faults: list[Fault],
    note: str = "",
    proof_date: date = BALANCE_DATE,
    notes: list[Fault] | None = None,
) -> dict:
    """`faults` put the books out; `notes` are findings that explain nothing (the books agree),
    such as a gap a gap journal already fills. A variant with no faults must agree everywhere."""
    notes = notes or []
    sim = simulate(uploads, commands)
    dir = HERE / dir_name
    write_files(dir, uploads)
    accounts = sorted({f.account for f in faults})
    assert faults or notes, dir_name
    assert all(n.explains == 0 for n in notes), dir_name
    if not faults:
        for acct, rows in sim.checkpoints.items():
            assert all(r[2] == r[4] for r in rows), f"{dir_name}: {acct} is out"
    VARIANTS.append((dir_name, title, faults + notes, sim, accounts))
    expected = []
    info = {}
    for acct in accounts:
        rows = sim.checkpoints[acct]
        w = window(rows)
        assert w["first_differs"] is not None, f"{dir_name}: {acct} agrees everywhere"
        at = [r for r in rows if r[0] <= proof_date]
        diff_at = at[-1][4] - at[-1][2]
        total = sum(f.explains for f in faults if f.account == acct)
        assert diff_at == total, f"{dir_name}: {acct} differs by {diff_at}, faults say {total}"
        # The other account is untouched.
        for other in sim.checkpoints:
            if other not in accounts:
                assert all(r[2] == r[4] for r in sim.checkpoints[other]), dir_name
        expected.append(
            f"""[[expected]]
account = "{acct}"
# The proof on this date (the last checkpoint on or before it) is out by this much.
proof_date = {proof_date.isoformat()}
difference_cents = {diff_at}
shape = "{w['shape']}"
last_agrees = {cp_toml(w['last_agrees']) if w['last_agrees'] else '"none"'}
first_differs = {cp_toml(w['first_differs'])}
"""
        )
        info[acct] = (diff_at, w)
    fault_text = []
    for section, f in [("faults", f) for f in faults] + [("notes", n) for n in notes]:
        ev = "\n".join(f"  {e}," for e in f.evidence)
        fault_text.append(
            f"""[[{section}]]
suspect = "{f.suspect}"
account = "{f.account}"
explains_cents = {f.explains}
confidence = "{f.confidence}"
summary = "{f.summary}"
evidence = [
{ev}
]
fix = {f.fix}
"""
        )
    text = f"""{HEADER}
# {title}
{''.join(f'# {l}'.rstrip() + chr(10) for l in note.strip().splitlines())}
setup = "../clean/fixture.toml"

{chr(10).join(fault_text)}
{chr(10).join(expected)}
{uploads_toml(uploads, sim)}
{commands_toml(commands)}"""
    (dir / "fault.toml").write_text(text.rstrip() + "\n", encoding="utf-8")
    return info


def swap(ups: list[Upload], name: str, new: File | None) -> list[Upload]:
    out = []
    for u in ups:
        if u.file.name == name:
            if new is not None:
                out.append(Upload(new))
        else:
            out.append(u)
    return out


def insert_after(ups: list[Upload], name: str, new: Upload) -> list[Upload]:
    i = next(i for i, u in enumerate(ups) if u.file.name == name)
    return ups[: i + 1] + [new] + ups[i + 1 :]


def ref(f: File, t: Txn) -> str:
    return "{ line = " + line_ref(t, f) + " }"


def stmt(f: File) -> str:
    return f'{{ statement = "{f.name}" }}'


def main() -> None:
    clean, _ = write_clean()
    # 01a: the March card statement downloaded again from the bank's other OFX export, which puts
    # the merchant in MEMO. Same FITIDs, different descriptions, so M10's key misses every line.
    march = between(CARD, date(2026, 3, 1), date(2026, 3, 31))
    again = ofx_card_xml(
        "visa-march-2026.ofx",
        (date(2026, 3, 1), date(2026, 3, 31)),
        balance_at_end(CARD_OPENING, CARD, date(2026, 3, 31)),
        march,
        memo_first=True,
    )
    ups = clean + [Upload(again)]
    q4 = card_q4()
    ev = [ref(again, t) for t, _ in again.lines] + [stmt(q4)]
    info = write_variant(
        "01a-duplicates-two-names",
        "Duplicates: the same month downloaded twice, under two names, NAME against MEMO.",
        ups,
        clean_commands(ups),
        [
            Fault(
                "duplicates",
                "card",
                sum(t.cents for t, _ in again.lines),
                f"visa-march-2026.ofx repeats all {len(march)} March lines of "
                "visa-2026-01-01_03-31.ofx with the same FITIDs, but its NAME is the "
                "transaction type and the merchant is in MEMO.",
                ev,
                '[{ kind = "RemoveStatement", statement = "visa-march-2026.ofx" }]',
            )
        ],
        note="Every line of the second file matches a line of the first by FITID. The 19 Sep\n"
        "pair of identical PIKORUA CAFE purchases (in the clean set) must not be flagged Likely.",
    )

    # 01b: a 'recent activity' QIF dated by transaction date, overlapping the April-June OFX,
    # which is dated by posting date.
    p = (date(2025, 6, 25), date(2025, 6, 30))
    overlap = between(CARD, *p)
    activity = qif(
        "visa-activity-2025-06-25_06-30.qif",
        "card",
        f"Harbourlight Visa {CARD_MASK}",
        "CCard",
        (p[0], balance_before(CARD_OPENING, CARD, p[0])),
        overlap,
        use_tdate=True,
    )
    ups = insert_after(clean, "visa-2025-04-01_06-30.ofx", Upload(activity))
    q1 = card_q1()
    ev = []
    for (t, _), orig in zip(activity.lines, overlap, strict=True):
        ev.append(ref(activity, t))
        ev.append(ref(q1, orig))
    info = write_variant(
        "01b-duplicates-posting-date",
        "Duplicates: an overlap where one file uses the posting date and the other the "
        "transaction date.",
        ups,
        clean_commands(ups),
        [
            Fault(
                "duplicates",
                "card",
                sum(t.cents for t, _ in activity.lines),
                "visa-activity-2025-06-25_06-30.qif repeats two lines of "
                "visa-2025-04-01_06-30.ofx, each dated a day earlier (the purchase date, not "
                "the posting date), so M10's key misses them. M10 flags them possible "
                "duplicates. Every line of it repeats the OFX, so the whole file was uploaded "
                "twice.",
                ev,
                f'[{{ kind = "RemoveStatement", statement = "{activity.name}" }}]',
            )
        ],
        note="Within 3 days, same amount, same description once normalised. The 19 Sep pair of\n"
        "identical PIKORUA CAFE purchases (in the clean set) must not be flagged Likely.",
    )

    # 02: the August cheque statement was never uploaded. The server posts the change across the
    # gap as one gap journal, so the books agree with the bank: missing lines gives a note, not a
    # fault (docs/domain.md, "Bank vs books").
    aug = cheque_month(4)
    ups = swap(clean, aug.name, None)
    change = sum(t.cents for t, _ in aug.lines)
    info = write_variant(
        "02-missing-lines",
        "Missing lines: the August cheque statement was never uploaded.",
        ups,
        clean_commands(ups),
        [],
        notes=[
            Fault(
                "missing_lines",
                "cheque",
                0,
                "No statement covers 1 to 31 Aug 2025 on the cheque account. The server posts "
                f"the change across those days ({money(change)}, the July closing balance to the "
                "September opening) as one gap journal on 31 Aug, so the books agree with the "
                "bank. The card says so in a note and offers the upload.",
                ['{ gap = { account = "cheque", start = 2025-08-01, end = 2025-08-31 } }',
                 '{ journal = { kind = "gap", date = 2025-08-31, amount_cents = '
                 f"{change} }} }}",
                 stmt(cheque_month(3)), stmt(cheque_month(5))],
                '[{ kind = "UploadMissing", account = "cheque", start = 2025-08-01, '
                f'end = 2025-08-31, file = "../clean/{aug.name}" }}]',
            )
        ],
        note="A gap journal fills the gap, so nothing differs. Uploading the August statement\n"
        "reverses the gap journal and posts its lines instead.",
    )

    # 03: the owner typed the cheque account's opening balance before uploading anything.
    typed = 300000
    open_cmd = Cmd(
        "before_uploads",
        'kind = "SetOpeningBalance"\naccount = "cheque"\n'
        f"balance_cents = {typed}  # the first statement says {CHEQUE_OPENING}",
        fault=True,
        typed_opening=("cheque", typed),
    )
    first = cheque_month(0)
    info = write_variant(
        "03-wrong-opening-balance",
        "Wrong opening balance: typed by the owner, so the first statement's isn't used.",
        clean,
        [open_cmd] + clean_commands(clean),
        [
            Fault(
                "wrong_opening_balance",
                "cheque",
                typed - CHEQUE_OPENING,
                f"The opening balance entered, {money(typed)}, differs from the first "
                f"statement's, {money(CHEQUE_OPENING)}, so the difference is the same at every "
                "checkpoint.",
                [stmt(first), '{ command = "SetOpeningBalance" }'],
                '[{ kind = "SetOpeningBalance", account = "cheque", date = 2025-04-01, '
                f"amount_cents = {CHEQUE_OPENING} }}]",
            )
        ],
        note=f"{typed - CHEQUE_OPENING} cents doesn't divide by 9, so it isn't a transposition (see 10).",
    )

    # 04: the November cheque file has money out under Credit and money in under Debit.
    nov = cheque_month(7)
    swapped = cheque_month(7, swap_columns=True)
    ups = swap(clean, nov.name, swapped)
    net = sum(t.cents for t, _ in nov.lines)
    info = write_variant(
        "04-sign-wrong-way",
        "Sign the wrong way: a CSV's debit and credit columns read the wrong way round.",
        ups,
        clean_commands(ups),
        [
            Fault(
                "sign_wrong_way",
                "cheque",
                -2 * net,
                f"Every amount in {nov.name} is in the other column, so the file's net is read "
                f"as {money(-net)} instead of {money(net)}: the difference is twice the net. "
                "The file's own running balance breaks at its first row.",
                [stmt(swapped)],
                f'[{{ kind = "RemoveStatement", statement = "{nov.name}" }}, '
                f'{{ kind = "Upload", file = "../clean/{nov.name}" }}]',
            )
        ],
        note="Statement::balance_check fails at the first transaction row.",
    )

    # 05: the owner marked the late 28 Sep card line as a duplicate. It isn't.
    card3 = card_q3()
    w = woodmill_stored(card3)
    info = write_variant(
        "05-marked-duplicate-but-isnt",
        "Marked duplicate but isn't: the owner answered yes for a line M10 flagged.",
        clean,
        clean_commands(clean, woodmill_is_duplicate=True),
        [
            Fault(
                "marked_duplicate_but_isnt",
                "card",
                -w.cents,
                f"{card3.name} overlaps the file before it on 27 and 28 Sep, so M10 flagged its "
                "new 28 Sep WOODMILL HARDWARE line. The owner marked it a duplicate, but no "
                "other line of that amount is within 3 days.",
                [ref(card3, w)],
                f'[{{ kind = "UnmarkDuplicate", line = {line_ref(w, card3)} }}]',
            )
        ],
        note="In the clean set the same line is answered 'not a duplicate'.",
    )

    # 06: a journal by hand on the cheque account, with no statement line.
    hand = Cmd(
        "after_uploads",
        'kind = "PostJournal"\nclient_year = 2026  # the year to 31 March 2026\n'
        "date = 2025-10-14\n"
        'narration = "Cash sale banked"\n'
        'lines = [{ account = "600.01", amount_cents = 35000 }, '
        '{ account = "100", amount_cents = -35000 }]',
        fault=True,
        hand=("cheque", date(2025, 10, 14), 35000),
    )
    info = write_variant(
        "06-entries-by-hand",
        "Entries by hand: a journal on the bank account that no statement line matches.",
        clean,
        clean_commands(clean) + [hand],
        [
            Fault(
                "entries_by_hand",
                "cheque",
                35000,
                "A journal by hand, 'Cash sale banked', puts 350.00 into the cheque account on "
                "14 Oct 2025. No statement shows that deposit.",
                ['{ journal = { narration = "Cash sale banked", date = 2025-10-14 } }'],
                '[{ kind = "ReverseJournal", journal = { narration = "Cash sale banked", '
                "date = 2025-10-14 } }]",
            )
        ],
    )

    # 07: the January-March card OFX lists a purchase it dates 1 April, but its 31 March
    # LEDGERBAL already includes it.
    q4 = card_q4()
    late = next(t for t in reversed(q4.lines) if t[0].name == "GREENBARROW GROCERS")[0]
    moved = replace(late, date=date(2026, 4, 1))
    cut = card_q4([moved if t == late else t for t, _ in q4.lines])
    ups = swap(clean, q4.name, cut)
    info = write_variant(
        "07-date-cut-off",
        "Date cut-off: a line the file dates after its closing balance, which includes it.",
        ups,
        clean_commands(ups),
        [
            Fault(
                "date_cut_off",
                "card",
                -late.cents,
                f"{cut.name}'s LEDGERBAL at 31 Mar 2026 includes GREENBARROW GROCERS "
                f"{money(late.cents)}, but the file's DTPOSTED is 1 Apr 2026, so the ledger has "
                "it in the next year.",
                [ref(cut, moved)],
                "[]  # nothing to undo: the line belongs to 31 March in the bank's balance; "
                "the owner or accountant decides (a journal, or accept it as a timing difference)",
                confidence="likely",
            )
        ],
        note="The fault shows at the balance date; the line falls in the year to 31 March 2027.",
    )

    # 08: the owner's personal account QIF uploaded to the business cheque account.
    p = (date(2025, 11, 1), date(2025, 11, 30))
    personal_txns = [
        Txn(date(2025, 11, 4), -8460, "GREENBARROW GROCERS", "WELLINGTON"),
        Txn(date(2025, 11, 13), -6215, "KAURI PETROL", "NELSON"),
        Txn(date(2025, 11, 19), -1840, "PIKORUA CAFE", "WELLINGTON"),
        Txn(date(2025, 11, 22), -2273, "LANTERN BOOKS", "WELLINGTON"),
    ]
    personal = qif(
        "everyday-2025-11.qif",
        "cheque",
        "Everyday",
        "Bank",
        (p[0], 51230),
        personal_txns,
    )
    ups = insert_after(clean, cheque_month(7).name, Upload(personal, chosen=True))
    info = write_variant(
        "08-wrong-account",
        "Wrong account: the owner's personal account file uploaded to the business cheque account.",
        ups,
        clean_commands(ups),
        [
            Fault(
                "wrong_account",
                "cheque",
                sum(t.cents for t in personal_txns),
                "everyday-2025-11.qif names no account number, and the owner chose the cheque "
                "account for it. Its lines' net is the difference, and its own opening balance "
                "(512.30 on 1 Nov) is nowhere near the cheque account's.",
                [stmt(personal)],
                '[{ kind = "RemoveStatement", statement = "everyday-2025-11.qif" }]',
            )
        ],
        note="The upload sends bank_account_id (choose_account = true); the file has no number to\n"
        "refuse it with.",
    )

    # 09: the bank's February file prints one amount without its decimal point.
    feb = cheque_month(10)
    tele = next(t for t, _ in feb.lines if t.name == "TELEWAVE MOBILE")
    bad = cheque_month(10, misprint={tele.date: "3999"})
    ups = swap(clean, feb.name, bad)
    read = next(t for t, _ in bad.lines if t.date == tele.date)
    info = write_variant(
        "09-amount-read-wrong",
        "Amount read wrong: cents read as dollars.",
        ups,
        clean_commands(ups),
        [
            Fault(
                "amount_read_wrong",
                "cheque",
                read.cents - tele.cents,
                f"{bad.name} writes TELEWAVE MOBILE as 3999 (read as 3,999.00) where its running "
                "balance moves by 39.99: the difference is 99 times the line, and the file's "
                "own running balance breaks at that row.",
                [ref(bad, read)],
                "[]  # tell the owner and log the parser and row for us; the bank's file is wrong",
            )
        ],
        note="Statement::balance_check fails at the TELEWAVE MOBILE row.",
    )

    # 10: the owner typed the card's opening balance with two digits swapped.
    typed_card = -38160
    info = write_variant(
        "10-transposed-digits",
        "Transposed digits: the card's opening balance typed as 381.60 owed, not 318.60.",
        clean,
        [
            Cmd(
                "before_uploads",
                'kind = "SetOpeningBalance"\naccount = "card"\n'
                f"balance_cents = {typed_card}  # the first statement gives {CARD_OPENING}",
                fault=True,
                typed_opening=("card", typed_card),
            )
        ]
        + clean_commands(clean),
        [
            Fault(
                "transposed_digits",
                "card",
                typed_card - CARD_OPENING,
                "The card's opening balance was typed as -381.60; the first statement gives "
                "-318.60. The difference, 63.00, divides by 9, and swapping the 1 and the 8 "
                "gives it.",
                [stmt(card_q1()), '{ command = "SetOpeningBalance" }'],
                '[{ kind = "SetOpeningBalance", account = "card", date = 2025-04-01, '
                f"amount_cents = {CARD_OPENING} }}]",
            )
        ],
        note="wrong_opening_balance also explains this amount; transposed_digits is the more\n"
        "specific finding and must rank first.",
    )

    # 11: 03's typed opening balance, plus a cut-short re-download of late June on the cheque
    # account whose card-payment description is truncated, so M10's key misses it.
    p = (date(2025, 6, 20), date(2025, 6, 30))
    late_june = between(CHEQUE, *p)
    cut_txns = [
        replace(t, name="PAYMENT TO HARBOURLI") if t.name.startswith("PAYMENT TO") else t
        for t in late_june
    ]
    recent = kowhai_csv(
        "kowhai-cheque-2025-06-20_06-30.csv",
        p,
        balance_before(CHEQUE_OPENING, CHEQUE, p[0]),
        cut_txns,
    )
    dup = next(t for t, _ in recent.lines if t.name == "PAYMENT TO HARBOURLI")
    june = cheque_month(2)
    ups = insert_after(clean, june.name, Upload(recent))
    info = write_variant(
        "11-two-faults",
        "Two faults on the cheque account: a wrong opening balance and one duplicate.",
        ups,
        [open_cmd] + clean_commands(ups),
        [
            Fault(
                "wrong_opening_balance",
                "cheque",
                typed - CHEQUE_OPENING,
                f"As in 03: the opening balance entered, {money(typed)}, differs from the first "
                f"statement's, {money(CHEQUE_OPENING)}.",
                [stmt(first), '{ command = "SetOpeningBalance" }'],
                '[{ kind = "SetOpeningBalance", account = "cheque", date = 2025-04-01, '
                f"amount_cents = {CHEQUE_OPENING} }}]",
            ),
            Fault(
                "duplicates",
                "cheque",
                dup.cents,
                f"{recent.name} re-downloads 20 to 30 Jun. Its other lines match exactly, but "
                "the bank cut the card payment's text short (PAYMENT TO HARBOURLI), so M10's key "
                "missed it.",
                [ref(recent, dup), ref(june, next(t for t, _ in june.lines if t.date == dup.date))],
                f'[{{ kind = "MarkDuplicate", line = {line_ref(dup, recent)} }}]',
            ),
        ],
    )

    write_readme()
    (HERE / "faults.md").unlink(missing_ok=True)


def pretty(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    c = abs(cents)
    return f"{sign}{c // 100:,}.{c % 100:02d}"


def where(cp) -> str:
    if cp is None:
        return "none: out from the first balance"
    d, ph, _, label, _ = cp
    when = "start" if ph == 0 else "end"
    return f"{d.isoformat()} ({when} of day), {label}"


README_INTRO = """# Reconciliation fixtures (M18)

Synthetic statements for M18, "Every upload reconciles, or says why" (`PLAN.md`): a clean set
that agrees with the ledger at every balance the bank states, and one variant per suspect, each
the clean set plus exactly one fault. Synthetic only (CLAUDE.md hard rule 1): the business, the
owner, the merchants and the account numbers are invented, at the fictional banks of
`fixtures/bank-statements/`. The `99-` bank code is unassigned.

**Everything here is generated.** Edit `generate.py` and run `python fixtures/reconcile/generate.py`;
it rewrites every fixture directory and this README, the same way every run. It simulates the
ledger the way the server builds it (M10's exact duplicate key, the opening balance from the first
statement reaching the start date unless the owner typed one first, a line resolved as a duplicate
posting nothing, a gap journal for the change across days no statement covers) and the
checkpoints the way core walks them (only balances a file states, on the dates it states them, and
a running balance only where the file confirms it's the end of its day), and refuses to write a
fixture whose fault doesn't add up.
`crates/import/tests/reconcile_fixtures.rs` reads every file with the real parsers and checks the
clean set and the line references against them.

## The business

{owner}, a sole trader trading as {business}. Start date 1 Apr 2025, balance date 31 Mar 2026, not
registered for GST. Two accounts, added in this order, so their codes are fixed:

| Key | Account | Number | Code | Opening, 1 Apr 2025 | Closing, 31 Mar 2026 | Lines |
|---|---|---|---|---|---|---|
| `cheque` | Kowhai Co-operative Bank cheque account (`AddBankAccount`) | {cheque_number} | 600.01 | {cheque_open} | {cheque_close} | {cheque_lines} |
| `card` | Harbourlight Bank Visa (`AddCardAccount`) | {card_mask} | 850.01 | {card_open} | {card_close} | {card_lines} |

Card amounts are signed from the card's point of view (a balance owed is negative), as in
`fixtures/bank-statements/README.md`. Each month the cheque account pays the card's balance in full
on the 24th (`PAYMENT TO HARBOURLIGHT VISA 5290` out, `PAYMENT RECEIVED` in on the card).

## The clean set (`clean/`)

`clean/fixture.toml` has the setup (business, accounts), the 16 uploads in order, the commands to
replay, and the expected closing balances. Every opening, closing and running balance agrees with
the ledger ({cheque_cps} on the cheque account, {card_cps} on the card), and so does 31 March.

| Files | Format | What the file states |
|---|---|---|
| `kowhai-cheque-YYYY-MM.csv` (12) | Kowhai CSV (layout A), one per month | opening, closing, and a running balance on every row |
| `visa-2025-04-01_06-30.ofx` | OFX 2.2 (XML) card statement | closing only (`LEDGERBAL` 30 Jun) |
| `visa-2025-07-01_09-28.qif` | QIF `!Type:CCard` | opening entry only (start of 1 Jul) |
| `visa-2025-09-27_12-31.qif` | QIF `!Type:CCard` | opening entry only (start of 27 Sep) |
| `visa-2026-01-01_03-31.ofx` | OFX 1.02 (SGML) card statement | closing only (`LEDGERBAL` 31 Mar) |

Things the clean set holds on purpose:
- **At most one cheque line a day**, so a running balance is also the balance at the end of its day,
  whichever way same-day lines are ordered.
- **Two identical purchases on 19 Sep 2025** on the card (`PIKORUA CAFE WELLINGTON`, -7.20 each, in
  the July to September QIF). Both are real. The duplicates suspect must not flag them as Likely.
- **An overlap that M10 flags.** The July to September QIF was downloaded on 28 Sep, before a late
  `WOODMILL HARDWARE` -64.80 posted that day. The next QIF starts at 27 Sep, so its 27 and 28 Sep
  lines repeat (M10's key drops them) and the late line is new but flagged a possible duplicate.
  The clean set replays `ResolveDuplicate` with `is_duplicate = false` for it; 05 says yes instead.
- **Opening balances come from the files**: the April CSV states the cheque account's, and the
  card's is the first OFX's closing balance less its lines. Nobody types one, except in 03, 10
  and 11.

## How a fixture is described

Each variant has a `fault.toml` beside its files:
- `setup`: the business and accounts, always `../clean/fixture.toml`.
- `[[faults]]`: the `suspect` (PLAN.md's list, in snake case), the `account`, `explains_cents` (the
  part of the difference it accounts for), `confidence`, a `summary`, the `evidence` (lines by file,
  row, date, amount and description as the parser reads them; statements by file name; gaps; the
  command that caused it) and the `fix` that clears it, which is the one its suspect suggests. One
  entry, except in 11, and none in 02.
- `[[notes]]`: as `[[faults]]`, for a finding that explains nothing because the books agree
  (`explains_cents = 0`). Only 02 has one: a gap the server already filled with a gap journal.
- `[[expected]]`: per account that's out, the `difference_cents` at `proof_date` (the last stated
  balance on or before it), the `shape` (`jump`, `constant` or `drifting`), and the window: the
  stated balance that `last_agrees` and the one that `first_differs`.
- `[[uploads]]`: every file in upload order, with `choose_account = true` where the upload must send
  `bank_account_id` (the file names no account), and how many lines M10 should add.
- `[[commands]]`: commands to replay `before_uploads` or `after_uploads`, with `fault = true` on the
  one that is the fault. Accounts are named by key (`cheque`, `card`), and lines as in evidence.

Amounts are integer cents. A difference is the ledger less the bank's stated balance, as
`acct_core::reconcile` reports it. An opening balance is the balance at the start of its date, a
closing or running balance the balance at the end of its date.

## Faults

Differences are at 31 Mar 2026, ledger less bank. Only the account named is out; the other agrees
everywhere. 02 isn't here: nothing differs (see its note below).

| Fixture | Suspect | What's wrong | Account | Difference | Shape | Last agrees | First differs |
|---|---|---|---|---|---|---|---|
"""

README_NOTES = """
Notes on particular fixtures:
- **01a and 01b** are both duplicates: 01a a second export of March whose NAME holds the
  transaction type and MEMO the merchant (same FITIDs), 01b a "recent activity" QIF dated by the
  purchase date, overlapping an OFX dated by the posting date. The 19 Sep identical pair is in
  both, and isn't a duplicate. Every line of 01b's activity file repeats the OFX, so its fix is to
  remove that statement, as the suspect suggests, rather than mark each line.
- **02** has no fault. With August missing, the server posts the change across the gap
  (419.18 out) as one gap journal on 31 Aug, so the ledger agrees with every balance the bank
  states and Bank vs books says it agrees. Missing lines reports the gap as a note that explains
  nothing (`[[notes]]`), offering the August upload, which reverses the gap journal and posts the
  lines instead (`docs/domain.md`, "Bank vs books").
- **03 and 11** type the cheque account's opening balance (3,000.00) before the first upload, so the
  April statement's 3,264.85 isn't used. The difference doesn't divide by 9.
- **10** types the card's opening as -381.60 for -318.60: 63.00 divides by 9, and swapping the 1 and
  the 8 gives it. `wrong_opening_balance` also explains it; `transposed_digits` is more specific
  and must rank first.
- **04 and 09** fail `Statement::balance_check` on purpose (at the first row, and at the TELEWAVE
  MOBILE row). Every other file passes it, or skips it because the format states only one end.
  In 04 the swapped file's running balances don't follow from the amounts read, so only its last
  (which the closing balance confirms) is a checkpoint, and the difference jumps once.
- **07**'s line is dated 1 Apr 2026, so it lands in the year to 31 March 2027.
- **08**'s file names no account, so the upload chooses the cheque account
  (`choose_account = true`). A file naming another account would be refused (`wrong_bank_account`).
- **11** re-downloads 20 to 30 June on the cheque account. Three of its lines match exactly; the card
  payment's text is cut short (`PAYMENT TO HARBOURLI`), so M10's key misses it. With the typed
  opening balance, the two amounts add up to the difference exactly.

**Worked-out balances aren't checkpoints here.** M10 stores a balance for both ends of every
statement, working out the end the file doesn't state (opening + lines, or closing − lines). The
windows above count only balances the files state. A worked-out balance can't disagree with its own
file, only with a later upload, and in the clean set one does: `visa-2025-07-01_09-28.qif` was
downloaded on 28 Sep before the late `WOODMILL HARDWARE` -64.80 posted, so its worked-out closing
for 28 Sep is 64.80 more than the ledger's, while every stated balance agrees. That's what a
mid-day download looks like at a real bank, and an OFX's stated `LEDGERBAL` taken then would be off
the same way. If core counted worked-out balances, the clean set would show a window at 28 Sep, and
10's `constant` shape would break there.

## Fixes, and the commands they need

Each `fix` is the one its suspect suggests (`crates/import/tests/reconcile_suspects.rs` checks it).
Some need commands M18 Agent 6 adds or extends:

| Fix | Fixtures | Command |
|---|---|---|
| `RemoveStatement` | 01a, 01b, 04 (then upload the clean file), 08 | `remove_statement`: new (Agent 6) |
| `SetOpeningBalance` | 03, 10, 11 | correcting an opening balance that's already set: new (Agent 6); `set_opening_balance` only sets one once |
| `MarkDuplicate` | 11 | `resolve_duplicate` with `is_duplicate = true` (the line is flagged) |
| `UnmarkDuplicate` | 05 | `resolve_duplicate` with `is_duplicate = false` |
| `ReverseJournal` | 06 | `reverse_journal` |
| `UploadMissing` | 02 (a note) | `import_statement` of the missing file |
| none | 07, 09 | nothing to send: the owner or accountant decides |
"""


def write_readme() -> None:
    rows = []
    for dir_name, title, faults, sim, accounts in VARIANTS:
        suspects = " + ".join(f"`{f.suspect}`" for f in faults)
        for acct in accounts:
            w = window(sim.checkpoints[acct])
            at = [r for r in sim.checkpoints[acct] if r[0] <= BALANCE_DATE][-1]
            rows.append(
                f"| `{dir_name}` | {suspects} | {title} | {acct} | {pretty(at[4] - at[2])} "
                f"| {w['shape']} | {where(w['last_agrees'])} | {where(w['first_differs'])} |"
            )
    ups = clean_uploads()
    clean = simulate(ups, clean_commands(ups))
    text = README_INTRO.format(
        owner=OWNER,
        business=BUSINESS,
        cheque_number=CHEQUE_NUMBER,
        card_mask=CARD_MASK,
        cheque_open=pretty(CHEQUE_OPENING),
        card_open=pretty(CARD_OPENING),
        cheque_close=pretty(clean.closing["cheque"]),
        card_close=pretty(clean.closing["card"]),
        cheque_lines=len(CHEQUE),
        card_lines=len(CARD),
        cheque_cps=len(clean.checkpoints["cheque"]),
        card_cps=len(clean.checkpoints["card"]),
    )
    (HERE / "README.md").write_text(text + "\n".join(rows) + "\n" + README_NOTES, encoding="utf-8")


# Every variant written, for the README: (directory, title, faults, simulation, accounts out).
VARIANTS: list = []


if __name__ == "__main__":
    main()
