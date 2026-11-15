import { Fragment, useState } from "react";
import { formatDate } from "../lib/dates";
import { Emoji } from "../lib/icons";
import { formatMoney, parseMoney } from "../lib/money";
import {
  addLineAfter,
  balanceSuggestions,
  dateSuggestions,
  editLine,
  type Fixed,
  type FixedLine,
  type Fixes,
  type LineEdit,
  NO_FIXES,
  refKey,
  replaceEdit,
  type Suggestion,
  undoLine,
} from "../lib/pdfToOfx/fixes";
import type { ReadStatement } from "../lib/pdfToOfx/read";
import { Badge, Button, DateField, Field, Notice } from "../ui";
import styles from "./PdfToOfxPage.module.css";

interface Props {
  read: ReadStatement;
  fixes: Fixes;
  onFixes: (fixes: Fixes) => void;
  fixed: Fixed;
  /** 1, or -1 while money in and out are swapped: amounts are shown times this. */
  flip: 1 | -1;
}

/** Turns a sign round without making a negative zero. */
const negate = (cents: number) => (cents === 0 ? 0 : -cents);

const inOrOut = (cents: number) => `${formatMoney(Math.abs(cents))} ${cents > 0 ? "in" : "out"}`;

/** The button's words for a way to put a line right, with amounts as they're shown. */
function suggestionLabel(s: Suggestion, flip: 1 | -1): { icon: string; text: string } {
  const cents = typeof s.value === "number" ? (flip === 1 ? s.value : negate(s.value)) : 0;
  const date = typeof s.value === "string" ? formatDate(s.value) : "";
  switch (s.kind) {
    case "amount":
      return { icon: "💵", text: `The amount is ${inOrOut(cents)}` };
    case "balance":
      return { icon: "🧮", text: `The balance is ${formatMoney(cents)}` };
    case "missing":
      return { icon: "➕", text: `A line of ${inOrOut(cents)} is missing above it` };
    case "opening":
      return { icon: "🏁", text: `Start from an opening balance of ${formatMoney(cents)}` };
    case "remove":
      return { icon: "🗑️", text: "It isn't a transaction: take it out" };
    case "dateRight":
      return { icon: "✅", text: `${date} is right` };
    case "date":
      return { icon: "📅", text: `It's ${date}` };
  }
}

/** Every line read, each with a way to change it, and buttons to put right those that don't add up. */
export function StatementLines({ read, fixes, onFixes, fixed, flip }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const shown = (cents: number) => (flip === 1 ? cents : negate(cents));
  const firstIssue = fixed.all.find((l) => !l.removed && (l.balanceOff !== undefined || l.dateUnread));
  const originalIssues = read.lines.filter((l) => l.balanceOff !== undefined || l.dateUnread).length;

  const addAfter = (line: FixedLine) => {
    const { fixes: next, key } = addLineAfter(fixes, line.ref, { date: line.date, description: "", amount: 0, balance: null });
    onFixes(next);
    setEditing(refKey({ added: key }));
  };

  return (
    <>
      <div className={styles.fixSummary}>
        {fixed.issues > 0 ? (
          <Notice tone="warn" role="status">
            {fixed.issues === 1 ? "One line needs a look" : `${fixed.issues} lines need a look`}: the running balance
            doesn't follow, or the date couldn't be read. Each is marked below, with buttons to put it right from the
            statement. The totals and the file change as you go.{" "}
            {firstIssue && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => document.getElementById(`line-${refKey(firstIssue.ref)}`)?.scrollIntoView?.({ block: "center" })}
              >
                <Emoji>⬇️</Emoji> Show me
              </Button>
            )}
          </Notice>
        ) : (
          originalIssues > 0 && (
            <Notice tone="ok" role="status">
              Every line checks out now: each running balance follows from the one before.
            </Notice>
          )
        )}
        {fixed.changes > 0 && (
          <p className={styles.changes}>
            <Emoji>✏️</Emoji> {fixed.changes === 1 ? "One change" : `${fixed.changes} changes`} of yours are in the file.{" "}
            <Button size="sm" variant="ghost" onClick={() => onFixes(NO_FIXES)}>
              <Emoji>↩️</Emoji> Undo them all
            </Button>
          </p>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className="table" aria-label="Transactions">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th className="num">Money in</th>
              <th className="num">Money out</th>
              <th className="num">Balance</th>
              <th>
                <span className={styles.visuallyHidden}>Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {fixed.all.map((l) => {
              const key = refKey(l.ref);
              const issue = !l.removed && (l.balanceOff !== undefined || l.dateUnread === true);
              if (editing === key) {
                return (
                  <tr key={key} className={styles.editRow}>
                    <td colSpan={6}>
                      <EditLine
                        line={l}
                        flip={flip}
                        original={"read" in l.ref ? read.lines[l.ref.read]! : null}
                        onSave={(edit) => {
                          onFixes("read" in l.ref ? replaceEdit(fixes, l.ref.read, edit) : editLine(fixes, l.ref, edit));
                          setEditing(null);
                        }}
                        onRemove={() => {
                          onFixes(editLine(fixes, l.ref, { removed: true }));
                          setEditing(null);
                        }}
                        onAddAfter={() => addAfter(l)}
                        onCancel={() => {
                          // A line just added and never filled in goes again.
                          if (l.added && l.amount === 0) onFixes(undoLine(fixes, l.ref));
                          setEditing(null);
                        }}
                      />
                    </td>
                  </tr>
                );
              }
              return (
                <Fragment key={key}>
                  <tr
                    id={`line-${key}`}
                    className={[issue ? styles.off : "", l.removed ? styles.removed : "", l.changed ? styles.changed : ""].join(" ").trim() || undefined}
                  >
                    <td className={styles.date}>
                      {formatDate(l.date)}
                      {l.madeOn && <span className={styles.madeOn}>made {formatDate(l.madeOn)}</span>}
                      {l.dateUnread && (
                        <span className={styles.madeOn}>
                          <Emoji>⚠️</Emoji> date unclear: the line above's
                        </span>
                      )}
                    </td>
                    <td>
                      {l.description || <span className="muted">(no description)</span>}
                      {l.added && (
                        <>
                          {" "}
                          <Badge tone="accent">added by you</Badge>
                        </>
                      )}
                      {l.changed && !l.added && (
                        <>
                          {" "}
                          <Badge tone="accent">changed by you</Badge>
                        </>
                      )}
                      {l.removed && (
                        <>
                          {" "}
                          <Badge>taken out</Badge>
                        </>
                      )}
                    </td>
                    <td className="num">{shown(l.amount) > 0 ? formatMoney(shown(l.amount)) : ""}</td>
                    <td className="num">{shown(l.amount) < 0 ? formatMoney(negate(shown(l.amount))) : ""}</td>
                    <td className="num">
                      {l.balanceOff !== undefined && (
                        <span title={`This balance is ${formatMoney(shown(l.balanceOff))} away from the one before plus this line`}>
                          <Emoji>⚠️</Emoji>{" "}
                        </span>
                      )}
                      {l.balance === null ? "" : formatMoney(shown(l.balance))}
                    </td>
                    <td className={styles.rowActions}>
                      {l.removed ? (
                        <Button size="sm" variant="ghost" onClick={() => onFixes(undoLine(fixes, l.ref))}>
                          <Emoji>↩️</Emoji> Put back
                        </Button>
                      ) : (
                        <>
                          {l.changed && !l.added && (
                            <Button size="sm" variant="ghost" onClick={() => onFixes(undoLine(fixes, l.ref))}>
                              <Emoji>↩️</Emoji> Undo
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Change the line ${formatDate(l.date)} ${l.description}`}
                            onClick={() => setEditing(key)}
                          >
                            <Emoji>✏️</Emoji> Change
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                  {issue && (
                    <tr className={styles.fixRow}>
                      <td colSpan={6}>
                        <LineFixes
                          read={read}
                          fixes={fixes}
                          fixed={fixed}
                          line={l}
                          flip={flip}
                          onFixes={onFixes}
                          onEdit={() => setEditing(key)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** What's wrong with a marked line, and a button for each way to put it right. */
function LineFixes(p: {
  read: ReadStatement;
  fixes: Fixes;
  fixed: Fixed;
  line: FixedLine;
  flip: 1 | -1;
  onFixes: (fixes: Fixes) => void;
  onEdit: () => void;
}) {
  const { line, flip } = p;
  const shown = (cents: number) => (flip === 1 ? cents : negate(cents));
  const balanceWays = balanceSuggestions(p.read, p.fixes, p.fixed, line);
  const dateWays = dateSuggestions(p.fixes, p.fixed, line);
  const buttons = (ways: Suggestion[]) =>
    ways.map((s) => {
      const { icon, text } = suggestionLabel(s, flip);
      return (
        <Button key={`${s.kind}-${String(s.value)}`} size="sm" variant={s.best ? "primary" : "secondary"} onClick={() => p.onFixes(s.fixes)}>
          <Emoji>{icon}</Emoji> {text}
          {s.best && (
            <>
              {" "}
              <span className={styles.likely}>(most likely)</span>
            </>
          )}
        </Button>
      );
    });
  return (
    <div className={styles.fixes}>
      {line.balanceOff !== undefined && line.balance !== null && (
        <div className={styles.fixGroup}>
          <p className={styles.fixText}>
            <Emoji>⚠️</Emoji> After this line the balance should be {formatMoney(shown(line.balance - line.balanceOff))}, but
            it reads {formatMoney(shown(line.balance))}: {formatMoney(Math.abs(line.balanceOff))} apart. Which is right on
            the statement?
          </p>
          <div className={styles.fixButtons}>
            {buttons(balanceWays)}
            <Button size="sm" variant="ghost" onClick={p.onEdit}>
              <Emoji>✏️</Emoji> Something else: change the line
            </Button>
          </div>
        </div>
      )}
      {line.dateUnread && (
        <div className={styles.fixGroup}>
          <p className={styles.fixText}>
            <Emoji>📅</Emoji> We couldn't read this line's date, so it has the date of the line printed above it. What
            does the statement say?
          </p>
          <div className={styles.fixButtons}>
            {buttons(dateWays)}
            <Button size="sm" variant="ghost" onClick={p.onEdit}>
              <Emoji>✏️</Emoji> Another date
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Money as a box shows it: blank for nothing. */
const boxMoney = (cents: number | null) => (cents === null || cents === 0 ? "" : formatMoney(cents));

/** A line's date, words and money, to change by hand. */
function EditLine(p: {
  line: FixedLine;
  flip: 1 | -1;
  /** The line as read, for a read line: only what differs from it is kept as a change. */
  original: FixedLine | ReadStatement["lines"][number] | null;
  onSave: (edit: LineEdit) => void;
  onRemove: () => void;
  onAddAfter: () => void;
  onCancel: () => void;
}) {
  const { line, flip } = p;
  const shownAmount = flip === 1 ? line.amount : negate(line.amount);
  const [date, setDate] = useState(line.date);
  const [description, setDescription] = useState(line.description);
  const [moneyIn, setMoneyIn] = useState(boxMoney(shownAmount > 0 ? shownAmount : null));
  const [moneyOut, setMoneyOut] = useState(boxMoney(shownAmount < 0 ? -shownAmount : null));
  const [balance, setBalance] = useState(line.balance === null ? "" : formatMoney(flip === 1 ? line.balance : negate(line.balance)));
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const into = moneyIn.trim() === "" ? 0 : parseMoney(moneyIn);
    const out = moneyOut.trim() === "" ? 0 : parseMoney(moneyOut);
    const bal = balance.trim() === "" ? null : parseMoney(balance);
    if (!date) return setError("Give the line a date.");
    if (into === null || out === null || into < 0 || out < 0) return setError("Type money in and money out as amounts, such as 1,234.56.");
    if (into !== 0 && out !== 0) return setError("A line is money in or money out, not both.");
    if (into === 0 && out === 0) return setError("Type the amount, in or out.");
    if (balance.trim() !== "" && bal === null) return setError("Type the balance as an amount, such as -1,234.56, or leave it blank.");
    const amount = flip === 1 ? into - out : out - into;
    const newBalance = bal === null ? null : flip === 1 ? bal : negate(bal);
    const o = p.original;
    if (!o) return p.onSave({ date, description: description.trim(), amount, balance: newBalance });
    // Only what differs from the line as read is a change; a date confirmed by saving it counts.
    const edit: LineEdit = {};
    if (date !== o.date) edit.date = date;
    else if (o.dateUnread) edit.dateChecked = true;
    if (description.trim() !== o.description) edit.description = description.trim();
    if (amount !== o.amount) edit.amount = amount;
    if (newBalance !== o.balance) edit.balance = newBalance;
    p.onSave(edit);
  };

  return (
    <form
      className={styles.editForm}
      aria-label="Change the line"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className={styles.editFields}>
        <DateField label="Date" value={date} onChange={setDate} />
        <Field label="Description">
          <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Money in">
          <input inputMode="decimal" value={moneyIn} onChange={(e) => setMoneyIn(e.target.value)} />
        </Field>
        <Field label="Money out">
          <input inputMode="decimal" value={moneyOut} onChange={(e) => setMoneyOut(e.target.value)} />
        </Field>
        <Field label="Balance" hint="Leave it blank if the statement shows none here.">
          <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
        </Field>
      </div>
      {error && (
        <Notice tone="warn" role="alert">
          {error}
        </Notice>
      )}
      <div className={styles.fixButtons}>
        <Button size="sm" variant="primary" type="submit">
          <Emoji>✅</Emoji> Save
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onRemove}>
          <Emoji>🗑️</Emoji> Take this line out
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onAddAfter}>
          <Emoji>➕</Emoji> Add a line after it
        </Button>
      </div>
    </form>
  );
}
