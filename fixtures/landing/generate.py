"""Writes the three landing-page example OFX files (M20). Money is integer cents throughout.

Run from the repo root: python -I fixtures/landing/generate.py fixtures/landing
"""
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)


def cents(s):
    neg = s.startswith("-")
    s = s.lstrip("-").replace(",", "")
    d, c = s.split(".")
    v = int(d) * 100 + int(c)
    return -v if neg else v


def fmt(v):
    sign = "-" if v < 0 else ""
    v = abs(v)
    return f"{sign}{v // 100}.{v % 100:02d}"


# ---------------------------------------------------------------- example 1
# Tui Street Coffee: coffee cart, GST registered. Classic OFX 1.02 SGML, LF,
# unclosed leaf tags, date-only DTPOSTED, one calendar month.
ex1_open = cents("3184.20")
ex1 = [
    ("20251001", "DIRECTDEP", "612.40", "TAPPA PAYMENTS SETTLE", "MERCH 4471 30SEP"),
    ("20251002", "POS", "-248.60", "RANGI ROASTERS LTD", "EFTPOS 01OCT WELLINGTON"),
    ("20251003", "DIRECTDEP", "534.15", "TAPPA PAYMENTS SETTLE", "MERCH 4471 02OCT"),
    ("20251003", "DIRECTDEBIT", "-96.00", "HILLTOP DAIRY SUPPLY", "DD 88213"),
    ("20251006", "DIRECTDEP", "1288.90", "TAPPA PAYMENTS SETTLE", "MERCH 4471 03-05OCT"),
    ("20251006", "POS", "-132.47", "FRESHWAY SUPERMARKET", "EFTPOS 05OCT NEWTOWN"),
    ("20251007", "DEBIT", "-65.00", "HARBOUR MARKETS TRUST", "STALL FEE OCT WK1"),
    ("20251008", "POS", "-88.30", "TUSSOCK FUEL TE ARO", "EFTPOS 07OCT"),
    ("20251009", "DIRECTDEP", "498.70", "TAPPA PAYMENTS SETTLE", "MERCH 4471 08OCT"),
    ("20251010", "XFER", "-500.00", "TRANSFER TO 99-2101-0045617-01", "SAVINGS"),
    ("20251013", "DIRECTDEP", "1402.35", "TAPPA PAYMENTS SETTLE", "MERCH 4471 10-12OCT"),
    ("20251014", "DIRECTDEBIT", "-59.99", "KORU MOBILE", "ACCT 3381920"),
    ("20251015", "POS", "-312.80", "RANGI ROASTERS LTD", "EFTPOS 14OCT WELLINGTON"),
    ("20251016", "CREDIT", "180.00", "J PATEL", "CATERING DEP"),
    ("20251017", "DIRECTDEP", "566.20", "TAPPA PAYMENTS SETTLE", "MERCH 4471 16OCT"),
    ("20251020", "DIRECTDEP", "1355.75", "TAPPA PAYMENTS SETTLE", "MERCH 4471 17-19OCT"),
    ("20251021", "DEBIT", "-65.00", "HARBOUR MARKETS TRUST", "STALL FEE OCT WK3"),
    ("20251022", "PAYMENT", "-1240.00", "INLAND REVENUE", "GST AUG-SEP"),
    ("20251023", "DIRECTDEBIT", "-102.00", "HILLTOP DAIRY SUPPLY", "DD 88213"),
    ("20251024", "DIRECTDEP", "611.05", "TAPPA PAYMENTS SETTLE", "MERCH 4471 23OCT"),
    ("20251027", "CREDIT", "1000.00", "M TAMIHANA", "LOAN FOR GRINDER"),
    ("20251028", "DIRECTDEP", "1198.40", "TAPPA PAYMENTS SETTLE", "MERCH 4471 24-27OCT"),
    ("20251028", "ATM", "-100.00", "ATM CUBA ST", "CASH"),
    ("20251029", "POS", "-1380.00", "BREWLINE EQUIPMENT", "GRINDER EFTPOS 29OCT"),
    ("20251030", "POS", "-61.20", "CUP AND LID WHOLESALE", "EFTPOS 29OCT"),
    ("20251031", "FEE", "-12.50", "MONTHLY ACCOUNT FEE", ""),
    ("20251031", "INT", "0.84", "INTEREST CREDIT", ""),
]
bal = ex1_open + sum(cents(a) for _, _, a, _, _ in ex1)
lines = [
    "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII",
    "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "",
    "<OFX>", "<SIGNONMSGSRSV1>", "<SONRS>", "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
    "<DTSERVER>20251101060000", "<LANGUAGE>ENG",
    "<FI><ORG>Piwakawaka Bank (SYNTHETIC)<FID>0099</FI>", "</SONRS>", "</SIGNONMSGSRSV1>",
    "<BANKMSGSRSV1>", "<STMTTRNRS>", "<TRNUID>0", "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
    "<STMTRS>", "<CURDEF>NZD", "<BANKACCTFROM>", "<BANKID>99", "<ACCTID>99-2101-0045617-00",
    "<ACCTTYPE>CHECKING", "</BANKACCTFROM>", "<BANKTRANLIST>", "<DTSTART>20251001",
    "<DTEND>20251031",
]
seen = {}
for d, t, a, n, m in ex1:
    seen[d] = seen.get(d, 0) + 1
    lines += ["<STMTTRN>", f"<TRNTYPE>{t}", f"<DTPOSTED>{d}", f"<TRNAMT>{fmt(cents(a))}",
              f"<FITID>{d}{seen[d]:03d}", f"<NAME>{n}"]
    if m:
        lines.append(f"<MEMO>{m}")
    lines.append("</STMTTRN>")
lines += ["</BANKTRANLIST>", "<LEDGERBAL>", f"<BALAMT>{fmt(bal)}", "<DTASOF>20251031", "</LEDGERBAL>",
          "<AVAILBAL>", f"<BALAMT>{fmt(bal)}", "<DTASOF>20251031", "</AVAILBAL>",
          "</STMTRS>", "</STMTTRNRS>", "</BANKMSGSRSV1>", "</OFX>", ""]
(OUT / "example-1-tui-street-coffee-2025-10.ofx").write_bytes("\n".join(lines).encode("ascii"))
print("ex1", len(ex1), "lines; open", fmt(ex1_open), "close", fmt(bal))

# ---------------------------------------------------------------- example 2
# Matai Design Studio: freelance designer, NOT GST registered. OFX 2.2 XML,
# UTF-8 with macrons, timestamps with NZ time zones (crosses the 28 Sep 2025
# daylight-saving change), three-digit account suffix, two months.
ex2_open = cents("2410.55")
ex2 = [
    ("20250801", "DIRECTDEBIT", "-34.00", "PIXELFORGE SUBSCRIPTION", "USD 19.99 INCL INTL FEE"),
    ("20250804", "CREDIT", "2875.00", "KŌRERO MEDIA LTD", "INV-1042"),
    ("20250805", "DIRECTDEBIT", "-1450.00", "R & S HOLDINGS", "RENT FLAT 2"),
    ("20250807", "POS", "-18.50", "KAPAI CAFÉ", "CONTACTLESS"),
    ("20250811", "CREDIT", "1200.00", "A MATAI", "FROM PARTNER"),
    ("20250812", "DIRECTDEBIT", "-89.00", "FIBRESTREAM INTERNET", "ACCT 77120"),
    ("20250815", "CREDIT", "4600.00", "WHENUA ARCHITECTS", "INV-1043 LOGO+WEB"),
    ("20250818", "POS", "-1899.00", "NOHO TECH STORE", "LAPTOP"),
    ("20250820", "DIRECTDEBIT", "-62.40", "FONTWORKS LIBRARY", "ANNUAL/12"),
    ("20250822", "PAYMENT", "-1500.00", "INLAND REVENUE", "INC TAX 2026"),
    ("20250825", "XFER", "-800.00", "TRANSFER TO 99-3305-0098765-001", "SAVINGS"),
    ("20250828", "CREDIT", "650.00", "HĀPAI TRUST", "INV-1044"),
    ("20250901", "DIRECTDEBIT", "-34.00", "PIXELFORGE SUBSCRIPTION", "USD 19.99 INCL INTL FEE"),
    ("20250903", "CREDIT", "3150.00", "KŌRERO MEDIA LTD", "INV-1045"),
    ("20250905", "DIRECTDEBIT", "-1450.00", "R & S HOLDINGS", "RENT FLAT 2"),
    ("20250909", "POS", "-245.00", "PRINTHAUS ŌTAUTAHI", "PROOFS"),
    ("20250912", "DIRECTDEBIT", "-89.00", "FIBRESTREAM INTERNET", "ACCT 77120"),
    ("20250916", "CREDIT", "2200.00", "WHENUA ARCHITECTS", "INV-1046"),
    ("20250919", "POS", "-64.90", "WHARE BOOKS", "CONTACTLESS"),
    ("20250922", "DIRECTDEBIT", "-62.40", "FONTWORKS LIBRARY", "ANNUAL/12"),
    ("20250926", "CREDIT", "1200.00", "A MATAI", "FROM PARTNER"),
    ("20250929", "DIRECTDEBIT", "-48.00", "CO-WORK HUB LYTTELTON", "DAY PASSES X3"),
    ("20250930", "FEE", "-5.00", "ACCOUNT FEE", ""),
    ("20250930", "INT", "1.12", "INTEREST", ""),
]
bal = ex2_open + sum(cents(a) for _, _, a, _, _ in ex2)


def stamp(d, hms="120000"):
    # New Zealand daylight time starts 28 Sep 2025.
    tz = "[+13:NZDT]" if d >= "20250928" else "[+12:NZST]"
    return f"{d}{hms}.000{tz}"


x = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
    "<OFX>",
    "  <SIGNONMSGSRSV1>",
    "    <SONRS>",
    "      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
    f"      <DTSERVER>{stamp('20251001', '083000')}</DTSERVER>",
    "      <LANGUAGE>ENG</LANGUAGE>",
    "      <FI><ORG>Tōtara Mutual Bank (SYNTHETIC)</ORG><FID>0099</FID></FI>",
    "    </SONRS>",
    "  </SIGNONMSGSRSV1>",
    "  <BANKMSGSRSV1>",
    "    <STMTTRNRS>",
    "      <TRNUID>1</TRNUID>",
    "      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
    "      <STMTRS>",
    "        <CURDEF>NZD</CURDEF>",
    "        <BANKACCTFROM>",
    "          <BANKID>99</BANKID>",
    "          <BRANCHID>3305</BRANCHID>",
    "          <ACCTID>99-3305-0098765-002</ACCTID>",
    "          <ACCTTYPE>CHECKING</ACCTTYPE>",
    "        </BANKACCTFROM>",
    "        <BANKTRANLIST>",
    f"          <DTSTART>{stamp('20250801', '000000')}</DTSTART>",
    f"          <DTEND>{stamp('20250930', '235959')}</DTEND>",
]
for i, (d, t, a, n, m) in enumerate(ex2, start=1):
    x += [
        "          <STMTTRN>",
        f"            <TRNTYPE>{t}</TRNTYPE>",
        f"            <DTPOSTED>{stamp(d)}</DTPOSTED>",
        f"            <TRNAMT>{fmt(cents(a))}</TRNAMT>",
        f"            <FITID>3305098765{d}{i:04d}</FITID>",
        f"            <NAME>{n.replace('&', '&amp;')}</NAME>",
    ]
    if m:
        x.append(f"            <MEMO>{m}</MEMO>")
    x.append("          </STMTTRN>")
x += [
    "        </BANKTRANLIST>",
    f"        <LEDGERBAL><BALAMT>{fmt(bal)}</BALAMT><DTASOF>{stamp('20250930', '235959')}</DTASOF></LEDGERBAL>",
    f"        <AVAILBAL><BALAMT>{fmt(bal - cents('48.00'))}</BALAMT><DTASOF>{stamp('20250930', '235959')}</DTASOF></AVAILBAL>",
    "      </STMTRS>",
    "    </STMTTRNRS>",
    "  </BANKMSGSRSV1>",
    "</OFX>",
    "",
]
(OUT / "example-2-matai-design-2025-08_09.ofx").write_bytes("\n".join(x).encode("utf-8"))
print("ex2", len(ex2), "lines; open", fmt(ex2_open), "close", fmt(bal))

# ---------------------------------------------------------------- example 3
# Kahu Electrical: electrician, GST registered, buys a van. OFX 1.02 SGML with
# CRLF line endings and every leaf closed, times on DTPOSTED, an account number
# written with spaces, a cheque with CHECKNUM, no AVAILBAL, a whole quarter.
ex3_open = cents("6842.90")
ex3 = [
    ("20250701", "DIRECTDEP", "3450.00", "MOANA PROPERTY MGMT", "INV 2231", None),
    ("20250703", "POS", "-682.45", "VOLTEDGE TRADE SUPPLIES", "ACCT 5521", None),
    ("20250704", "DIRECTDEBIT", "-189.00", "TRADESURE INSURANCE", "VAN POLICY", None),
    ("20250707", "POS", "-96.20", "SOUTHFUEL ROTORUA", "EFTPOS", None),
    ("20250709", "DIRECTDEP", "1840.00", "B NGATA", "SWITCHBOARD", None),
    ("20250711", "CHECK", "-420.00", "CHEQUE 000318", "", "000318"),
    ("20250714", "DIRECTDEP", "5175.00", "PURIRI BUILDERS LTD", "CLAIM 3", None),
    ("20250716", "POS", "-1215.80", "VOLTEDGE TRADE SUPPLIES", "ACCT 5521", None),
    ("20250718", "DIRECTDEBIT", "-68.00", "KORU MOBILE", "ACCT 5590213", None),
    ("20250721", "ATM", "-200.00", "ATM FENTON ST", "CASH", None),
    ("20250723", "POS", "-142.30", "FRESHWAY SUPERMARKET", "EFTPOS", None),
    ("20250725", "DIRECTDEP", "920.00", "T WIREMU", "HEAT PUMP", None),
    ("20250728", "PAYMENT", "-3100.00", "INLAND REVENUE", "GST MAY-JUN", None),
    ("20250731", "FEE", "-15.00", "ACCOUNT FEE", "", None),
    ("20250731", "INT", "2.10", "INTEREST", "", None),
    ("20250801", "XFER", "20000.00", "TRANSFER FROM 99 4410 0023456 01", "VAN SAVINGS", None),
    ("20250801", "DIRECTDEP", "2760.00", "MOANA PROPERTY MGMT", "INV 2240", None),
    ("20250804", "POS", "-28750.00", "ROTORUA MOTOR CENTRE", "VAN REGO KHE24", None),
    ("20250806", "POS", "-544.10", "VOLTEDGE TRADE SUPPLIES", "ACCT 5521", None),
    ("20250808", "CREDIT", "112.70", "VOLTEDGE TRADE SUPPLIES", "CREDIT NOTE CN-88", None),
    ("20250812", "DIRECTDEP", "4320.00", "PURIRI BUILDERS LTD", "CLAIM 4", None),
    ("20250815", "DIRECTDEBIT", "-189.00", "TRADESURE INSURANCE", "VAN POLICY", None),
    ("20250818", "DIRECTDEP", "1480.00", "LAKESIDE MOTEL", "INV 2246", None),
    ("20250820", "DIRECTDEBIT", "-68.00", "KORU MOBILE", "ACCT 5590213", None),
    ("20250822", "PAYMENT", "-412.00", "ACC", "LEVY 2025", None),
    ("20250826", "POS", "-97.40", "SOUTHFUEL ROTORUA", "EFTPOS", None),
    ("20250829", "DIRECTDEP", "2035.00", "B NGATA", "INV 2251", None),
    ("20250831", "FEE", "-15.00", "ACCOUNT FEE", "", None),
    ("20250831", "INT", "1.40", "INTEREST", "", None),
    ("20250902", "POS", "-873.65", "VOLTEDGE TRADE SUPPLIES", "ACCT 5521", None),
    ("20250905", "DIRECTDEP", "6210.00", "PURIRI BUILDERS LTD", "CLAIM 5", None),
    ("20250909", "CREDIT", "3961.33", "INLAND REVENUE", "GST REFUND JUL-AUG", None),
    ("20250911", "DIRECTDEBIT", "-189.00", "TRADESURE INSURANCE", "VAN POLICY", None),
    ("20250915", "DIRECTDEP", "1150.00", "T WIREMU", "INV 2255", None),
    ("20250917", "POS", "-310.00", "SPARKREG LICENSING", "PRACTISING LICENCE", None),
    ("20250919", "DIRECTDEBIT", "-68.00", "KORU MOBILE", "ACCT 5590213", None),
    ("20250922", "POS", "-1032.90", "VOLTEDGE TRADE SUPPLIES", "ACCT 5521", None),
    ("20250924", "ATM", "-200.00", "ATM FENTON ST", "CASH", None),
    ("20250926", "DIRECTDEP", "3890.00", "MOANA PROPERTY MGMT", "INV 2259", None),
    ("20250930", "FEE", "-15.00", "ACCOUNT FEE", "", None),
    ("20250930", "INT", "0.95", "INTEREST", "", None),
]
bal = ex3_open
low = bal
for r in ex3:
    bal += cents(r[2])
    low = min(low, bal)
assert low >= 0, "example 3 goes overdrawn"
s = [
    "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII",
    "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "",
    "<OFX>", "<SIGNONMSGSRSV1>", "<SONRS>",
    "<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
    "<DTSERVER>20251002071500</DTSERVER>", "<LANGUAGE>ENG</LANGUAGE>",
    "<FI><ORG>Kea Trust Bank (SYNTHETIC)</ORG><FID>0099</FID></FI>",
    "</SONRS>", "</SIGNONMSGSRSV1>", "<BANKMSGSRSV1>", "<STMTTRNRS>", "<TRNUID>0</TRNUID>",
    "<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>", "<STMTRS>", "<CURDEF>NZD</CURDEF>",
    "<BANKACCTFROM>", "<BANKID>99</BANKID>", "<ACCTID>99 4410 0023456 00</ACCTID>",
    "<ACCTTYPE>CHECKING</ACCTTYPE>", "</BANKACCTFROM>", "<BANKTRANLIST>",
    "<DTSTART>20250701000000</DTSTART>", "<DTEND>20250930235959</DTEND>",
]
for i, (d, t, a, n, m, chk) in enumerate(ex3, start=1):
    s += ["<STMTTRN>", f"<TRNTYPE>{t}</TRNTYPE>", f"<DTPOSTED>{d}120000</DTPOSTED>",
          f"<TRNAMT>{fmt(cents(a))}</TRNAMT>", f"<FITID>KT{i:05d}</FITID>"]
    if chk:
        s.append(f"<CHECKNUM>{chk}</CHECKNUM>")
    s.append(f"<NAME>{n}</NAME>")
    if m:
        s.append(f"<MEMO>{m}</MEMO>")
    s.append("</STMTTRN>")
s += ["</BANKTRANLIST>", "<LEDGERBAL>", f"<BALAMT>{fmt(bal)}</BALAMT>",
      "<DTASOF>20250930235959</DTASOF>", "</LEDGERBAL>", "</STMTRS>", "</STMTTRNRS>",
      "</BANKMSGSRSV1>", "</OFX>", ""]
(OUT / "example-3-kahu-electrical-2025-07_09.ofx").write_bytes("\r\n".join(s).encode("ascii"))
print("ex3", len(ex3), "lines; open", fmt(ex3_open), "close", fmt(bal), "lowest", fmt(low))
