"""Generates fixtures/ai/labelled-lines.json: synthetic NZ-style bank lines with their category.

Run: python tools/ai-labelled-lines/generate.py

Every merchant name is invented. Labels follow the sole-trader chart's default GST codes.
Deterministic: the same seed gives the same file.
"""
import json
import random

rng = random.Random(20261024)
import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..") + "/"
chart = json.load(open(ROOT + "fixtures/practice/sole-trader-chart.json", encoding="utf-8"))

HOLDING = {"140", "965"}
categories = []
for a in chart:
    if not a["active"] or a["code"] in HOLDING:
        continue
    if a["account_type"] == "income":
        categories.append({"key": a["code"], "name": a["name"], "direction": "in"})
    elif a["account_type"] == "expense":
        categories.append({"key": a["code"], "name": a["name"], "direction": "out"})
# Must match SPECIAL in crates/server/src/ai.rs.
categories += [
    {"key": "personal", "name": "Personal spending (not for the business)", "direction": "out"},
    {"key": "owner_funds", "name": "Money the owner put in (not income)", "direction": "in"},
    {"key": "loan", "name": "A loan received (not income)", "direction": "in"},
    {"key": "paye_wages", "name": "Wages already taxed through PAYE (not income)", "direction": "in"},
    {"key": "personal_sale", "name": "Sale of a personal item (not income)", "direction": "in"},
]

TOWNS = ["WELLINGTON", "PETONE", "LOWER HUTT", "PORIRUA", "AUCKLAND", "HAMILTON", "TAURANGA",
         "NAPIER", "NELSON", "CHRISTCHURCH", "DUNEDIN", "PALMERSTON NTH", "WHANGAREI", "MASTERTON"]

def card_ref():
    return f"{rng.randint(1000, 9999)}"

def styles(name):
    """Ways a bank might print a merchant."""
    town = rng.choice(TOWNS)
    return rng.choice([
        f"{name} {town}",
        f"EFTPOS {name} {town}",
        f"{name}",
        f"VISA PURCHASE {name} {town} CARD {card_ref()}",
        f"POS W/D {name}",
        f"{name} {town} NZ",
    ])

# (category key, gst, direction, amount range in dollars, merchants, how many lines, fixed formats)
SPEND = [
    ("150", "standard", (20, 900), ["TALLOWBY CRAFT SUPPLIES", "WICKWORKS WHOLESALE", "AMBERJAR PACKAGING", "KERERU FABRICS", "PAPAWAI TIMBER YARD"], 24),
    ("200", "standard", (150, 2500), ["HARAKEKE ACCOUNTING LTD", "TOTARA TAX ADVISERS", "LEDGERLY CHARTERED ACCTS"], 6),
    ("202", "standard", (80, 900), [], 4),
    ("204", "standard", (15, 600), ["SOCIALREACH ADS", "LOCAL GAZETTE ADVERTISING", "PRINTSMITH FLYERS", "MARKETSPACE LISTING FEE"], 14),
    ("205", "exempt", (1, 25), [], 14),
    ("215", "standard", (40, 1800), ["TUATARA INSURANCE", "SOUTHERLY INSURANCE", "KAITIAKI MUTUAL"], 9),
    ("220", "exempt", (5, 300), [], 5),
    ("225", "standard", (30, 140), ["RIVERBEND FUEL", "HILLTOP GAS STOP", "KOWHAI PETROLEUM", "MOTORMEND AUTO SERVICE", "TYRETOWN"], 26),
    ("230", "standard", (300, 2200), ["HARBOURVIEW PROPERTY MGMT", "STUDIO 7 LEASING"], 6),
    ("235", "standard", (40, 800), ["FIXIT HANDYMAN SERVICES", "SPARKRIGHT ELECTRICAL", "DRIPSTOP PLUMBING"], 8),
    ("242", "standard", (100, 1500), ["J T CONTRACTING", "PIXELWELL DESIGN STUDIO", "CLEANSWEEP CONTRACTORS"], 8),
    ("245", "standard", (20, 160), ["TELEWAVE MOBILE", "WIREWEAVE BROADBAND", "KORERO TELECOM"], 18),
    ("255", "standard", (45, 400), ["GRIDLINE POWER", "AWA ENERGY", "MOANA GAS NETWORKS"], 14),
    ("260", "standard", (6, 120), ["BRIGHTPOST COURIERS", "PARCELWAY", "SWIFTKIWI FREIGHT", "POSTBOX NZ SHOP"], 18),
    ("265", "standard", (5, 150), ["PAPERLEAF STATIONERS", "INKWELL OFFICE SUPPLY", "DESKMATE STATIONERY"], 12),
    ("270", "standard", (10, 120), ["LANTERN HOST WEB HOSTING", "LEDGERCLOUD SUBSCRIPTION", "SHOPSTALL MONTHLY PLAN", "DESIGNKIT PRO"], 16),
    ("275", "standard", (20, 600), ["SKYKIWI AIRLINES", "ROADRUNNER COACHES", "HARBOUR FERRIES", "TOTARA MOTOR LODGE", "CITYCAB TAXIS"], 12),
    ("280", "standard", (25, 900), ["TOOLSHED HARDWARE", "MITRE MAKERS TOOLS", "BENCHMARK HARDWARE"], 10),
    ("290", "standard", (5, 200), ["MARKET STALL FEE", "CRAFTFAIR SITE FEE", "COUNCIL DOG REGISTRATION"], 6),
    ("personal", "none", (5, 300), ["GREENBARROW GROCERS", "FRESHFARE SUPERMARKET", "PIKORUA CAFE", "KAHAWAI FISH AND CHIPS",
                                    "LITTLE LAMB KINDY", "STREAMFLIX", "GYMNASIA FITNESS", "WELLSPRING CHEMIST", "CINEMA PARADISO"], 40),
]

lines = []

def add(desc, cents, key, gst):
    lines.append({"description": desc, "amount": cents, "category": key, "gst": gst})

def dollars(lo, hi):
    return rng.randint(lo * 100, hi * 100)

for key, gst, (lo, hi), merchants, n in SPEND:
    for i in range(n):
        if key == "202":
            desc = rng.choice(["ACC LEVY INVOICE", "ACC WORK LEVY DD", "ACC LEVIES PAYMENT"]) + f" {rng.randint(100000, 999999)}"
        elif key == "205":
            desc = rng.choice(["ACCOUNT FEE", "MONTHLY ACCOUNT FEE", "EFTPOS TERMINAL FEE", "OVERSEAS TXN FEE", "DISHONOUR FEE", "BANK FEE"])
        elif key == "220":
            desc = rng.choice(["DEBIT INTEREST", "OVERDRAFT INTEREST", "LOAN INTEREST CHARGED", "CARD INTEREST CHARGE"])
        else:
            m = merchants[i % len(merchants)]
            desc = styles(m) if rng.random() < 0.7 else m + rng.choice(["", " DIRECT DEBIT", " ONLINE", " INV " + str(rng.randint(1000, 9999))])
        add(desc, -dollars(lo, hi), key, gst)

INCOME = [
    ("100", "standard", (15, 2500), 40),
    ("110", "exempt", (1, 60), 8),
    ("120", "standard", (50, 600), 5),
    ("owner_funds", "none", (100, 3000), 10),
    ("loan", "none", (1000, 15000), 4),
    ("paye_wages", "none", (600, 2400), 8),
    ("personal_sale", "none", (20, 900), 5),
]
SHOPS = ["HOLLOWAY GIFTS LTD", "AMBER & ASH BOUTIQUE", "BEEHIVE GIFTS LTD", "COASTAL CRAFT CO", "NORTHWIND HOMEWARES"]
for key, gst, (lo, hi), n in INCOME:
    for i in range(n):
        if key == "100":
            desc = rng.choice([
                f"{SHOPS[i % len(SHOPS)]} INV {rng.randint(100, 999):04d}",
                "PAYBLOOM PAYOUT ONLINE SALES",
                "SHOPSTALL PAYOUT",
                "EFTPOS SETTLEMENT MARKET SALES",
                f"DEPOSIT {SHOPS[i % len(SHOPS)]}",
            ])
        elif key == "110":
            desc = rng.choice(["CREDIT INTEREST", "INTEREST PAID", "BONUS SAVER INTEREST", "TERM DEPOSIT INTEREST"])
        elif key == "120":
            desc = rng.choice(["WORKSHOP TEACHING FEE", "CRAFT CLASS FEES", "COMMISSION RECEIVED"])
        elif key == "owner_funds":
            desc = rng.choice(["TOP-UP FROM PERSONAL", "TRANSFER FROM PERSONAL ACC", "OWNER CONTRIBUTION", "FUNDS INTRODUCED"])
        elif key == "loan":
            desc = rng.choice(["PERSONAL LOAN DRAWDOWN", "BUSINESS LOAN ADVANCE", "LOAN FROM FAMILY TRUST"])
        elif key == "paye_wages":
            desc = rng.choice(["SALARY HARBOUR CITY COUNCIL", "WAGES KAURI CAFE LTD", "PAYROLL TOTARA SCHOOL", "SALARY DEPOSIT"])
        else:
            desc = rng.choice(["SWAPMEET SALE OLD BIKE", "SOLD SOFA MARKETPLACE", "SALE OF PERSONAL CAR", "SECONDHAND KAYAK SALE"])
        add(desc, dollars(lo, hi), key, gst)

rng.shuffle(lines)
out = {
    "about": "Synthetic, labelled NZ-style bank lines for choosing an AI model (ADR 009). Every name is "
             "invented. Labels follow the sole-trader chart's default GST codes; a person still has to "
             "check them. `categories` are what Save tax offers a sole trader (crates/server/src/ai.rs). "
             "Amounts are signed cents: positive is money in.",
    "categories": categories,
    "lines": lines,
}
import os
os.makedirs(ROOT + "fixtures/ai", exist_ok=True)
with open(ROOT + "fixtures/ai/labelled-lines.json", "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(len(lines), "lines,", len(categories), "categories")
