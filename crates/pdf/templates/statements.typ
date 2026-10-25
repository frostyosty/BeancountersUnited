// The statements PDF (ADR 010). Our own layout (hard rule 3).
//
// It only lays out the ReportDoc in /doc.json: every amount is printed as given, in whole dollars.
// Presentation follows docs/domain.md, "Statement amounts and columns", the same rules as the web
// preview (apps/web/src/pages/StatementsTab.tsx). A rule changed here changes there too, in the
// same commit. /print.json holds what isn't in the ReportDoc: names, the draft flag and the
// reference printed in each footer. No emoji anywhere in accounting output.

#let doc = json("/doc.json")
#let print = json("/print.json")

// ---- Dates, as the preview writes them: "31 Mar 2026". ----

#let months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

#let parse-date(s) = {
  let p = s.split("-")
  datetime(year: int(p.at(0)), month: int(p.at(1)), day: int(p.at(2)))
}

#let show-date(s) = {
  let d = parse-date(s)
  str(d.day()) + " " + months.at(d.month() - 1) + " " + str(d.year())
}

// Exactly 12 months, such as 1 Apr 2025 to 31 Mar 2026: a year after the start, less a day, is
// the end. A 29 February start rolls to 1 March, as the preview's date arithmetic does.
#let full-year(start, end) = {
  let s = parse-date(start)
  let anniversary = if s.month() == 2 and s.day() == 29 {
    datetime(year: s.year() + 1, month: 3, day: 1)
  } else {
    datetime(year: s.year() + 1, month: s.month(), day: s.day())
  }
  anniversary - duration(days: 1) == parse-date(end)
}

#let period-line = {
  let p = doc.current_period
  "For the " + (if full-year(p.start, p.end) { "year" } else { "period" }) + " ended " + show-date(p.end)
}

// ---- Columns ----

#let has-prior = doc.prior_period != none
#let unfinalised = doc.comparatives == "unfinalised"

// "2026 $" and "2025 $", or full end dates if both periods end in the same calendar year.
#let column-heads = {
  let current = doc.current_period
  let prior = doc.prior_period
  let year(p) = p.end.slice(0, 4)
  if prior != none and year(prior) == year(current) {
    (show-date(current.end) + " $", show-date(prior.end) + " $")
  } else {
    (year(current) + " $", if prior != none { year(prior) + " $" } else { "" })
  }
}

#let amount-width = 2.7cm
#let widths = if has-prior { (1fr, amount-width, amount-width) } else { (1fr, amount-width) }
#let gutter = 0.5cm

// ---- Amounts: 1,234, (1,234) for negatives, a dash for nil, blank for none. ----

#let thousands(n) = {
  let s = str(n)
  let out = ""
  for (i, c) in s.clusters().enumerate() {
    if i > 0 and calc.rem(s.len() - i, 3) == 0 { out += "," }
    out += c
  }
  out
}

// The closing bracket hangs in a slot of its own, so 1,234 and (1,234) line up on the last digit.
#let bracket-slot(c) = context box(width: measure[)].width, c)

#let amount(v) = {
  if v == none {
    []
  } else if v == 0 {
    [–#bracket-slot[]]
  } else if v < 0 {
    [(#thousands(-v)#bracket-slot[)]]
  } else {
    [#thousands(v)#bracket-slot[]]
  }
}

// ---- Page furniture ----

// Each statement, the asset schedule and the notes start a "part". A page that a part runs onto
// gets "(continued)" and, for a table, its column headings again.
#let part-start(title, columns) = [#metadata((title: title, columns: columns))<part-start>]

#let column-head-row(footnote: false) = grid(
  columns: widths,
  column-gutter: gutter,
  inset: (y: 3pt),
  [],
  align(right, text(weight: "bold", column-heads.at(0))),
  ..if has-prior {
    (align(right, text(weight: "bold", column-heads.at(1) + if unfinalised { "*" } else { "" })),)
  },
)

#set document(
  title: print.client_name + ": financial statements",
  author: if print.practice_name != none { print.practice_name } else { () },
  date: none,
)

#set text(font: "Source Sans 3", size: 10pt, lang: "en", region: "NZ", number-width: "tabular")
#set par(leading: 0.55em, spacing: 0.9em)

#set page(
  paper: "a4",
  margin: (x: 2.2cm, top: 3.4cm, bottom: 2.4cm),
  header: context {
    let page = here().page()
    set text(size: 8pt)
    grid(
      columns: (1fr, auto),
      print.client_name,
      if print.practice_name != none { print.practice_name },
    )
    let started = query(<part-start>).filter(m => m.location().page() <= page)
    if started.len() > 0 and started.last().location().page() < page {
      let part = started.last().value
      set text(size: 10pt)
      v(0.6em)
      text(weight: "bold", part.title + " (continued)")
      if part.columns { column-head-row() }
    }
  },
  footer: context {
    set text(size: 8pt)
    grid(
      columns: (1fr, auto, 1fr),
      if print.draft { text(weight: "bold")[Draft: not finalised] },
      [Page #counter(page).display() of #counter(page).final().first()],
      align(right)[Ref #print.reference],
    )
  },
  background: if print.draft {
    rotate(-45deg, text(size: 110pt, weight: "bold", fill: luma(232))[DRAFT])
  },
)

// ---- Statements ----

#let double-rule = stack(
  spacing: 1.5pt,
  line(length: 100%, stroke: 0.5pt),
  line(length: 100%, stroke: 0.5pt),
)

#let row(r) = {
  let style = r.style
  let ruled = style == "group_total" or style == "total"
  let label = pad(left: r.depth * 1.2em, r.label)
  let label = if style == "heading" or style == "total" {
    text(weight: "bold", label)
  } else if style == "group_total" {
    emph(label)
  } else {
    label
  }
  let cell(v) = {
    let shown = if style == "heading" { [] } else { amount(v) }
    let shown = if style == "total" { text(weight: "bold", shown) } else { shown }
    grid.cell(
      align: right,
      stroke: if ruled { (top: 0.5pt) } else { none },
      if style == "total" { stack(spacing: 2.5pt, shown, double-rule) } else { shown },
    )
  }
  let amounts = (cell(r.current),)
  if has-prior { amounts.push(cell(r.prior)) }
  // A heading stays on the same page as the row after it.
  block(
    sticky: style == "heading",
    above: if style == "heading" { 0.9em } else { 0pt },
    below: 0pt,
    grid(columns: widths, column-gutter: gutter, inset: (y: 3pt), label, ..amounts),
  )
}

#let part-heading(title, columns: true, notice: false) = {
  part-start(title, columns)
  block(sticky: true, below: 0.6em, {
    align(center, {
      text(size: 13pt, weight: "bold", print.client_name)
      linebreak()
      text(size: 12pt, weight: "bold", title)
      if columns {
        linebreak()
        period-line
      }
    })
    if notice {
      v(0.4em)
      block(
        stroke: 0.5pt,
        inset: 6pt,
        width: 100%,
      )[The prior year isn't finalised, so the comparatives may still change.]
    }
    if columns { column-head-row() }
  })
}

#let footnote-unfinalised = if unfinalised and has-prior {
  v(0.6em)
  text(size: 8pt)[\* Unfinalised.]
}

#for (i, s) in doc.statements.enumerate() {
  if i > 0 { pagebreak() }
  part-heading(s.title, notice: unfinalised and i == 0)
  for r in s.rows { row(r) }
  footnote-unfinalised
}

// ---- The fixed asset schedule ----

#if doc.at("asset_schedule", default: none) != none {
  let schedule = doc.asset_schedule
  pagebreak(weak: true)
  part-heading(schedule.title)
  for b in schedule.blocks {
    row((style: "heading", depth: 0, label: b.title, current: none, prior: none))
    for r in b.rows {
      let style = if r.style == "total" { "group_total" } else { "line" }
      row((style: style, depth: 1, label: r.label, current: r.current, prior: r.prior))
    }
  }
  footnote-unfinalised
}

// ---- Notes ----

#let paragraph(text-with-breaks) = par(text-with-breaks.split("\n").map(l => [#l]).join(linebreak()))

#if doc.notes.len() > 0 {
  pagebreak(weak: true)
  part-heading(print.notes_title, columns: false)
  for n in doc.notes {
    block(sticky: true, above: 1.2em, below: 0.6em, text(size: 11pt, weight: "bold", str(n.number) + ". " + n.title))
    for s in n.sections {
      if s.title != none {
        block(sticky: true, above: 0.9em, below: 0.5em, text(weight: "bold", s.title))
      }
      for t in s.text { paragraph(t) }
    }
  }
}
