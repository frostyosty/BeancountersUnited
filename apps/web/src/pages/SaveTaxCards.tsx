import type { BankAccountView } from "@acct/types/BankAccountView";
import type { CardLine } from "@acct/types/CardLine";
import type { Command } from "@acct/types/Command";
import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import type { Suggestion } from "@acct/types/Suggestion";
import type { Via } from "@acct/types/Via";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatDate } from "../lib/dates";
import { Icon } from "../lib/icons";
import { formatMoney, parseMoney } from "../lib/money";
import { keys, useChart } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { CategoriseForm, describeCoding, incomeYearOf } from "./SaveTaxCategorise";
import styles from "./SaveTax.module.css";

interface CardProps {
  card: SaveTaxCard;
  clientId: string;
  banks: BankAccountView[];
  gstRegistered: boolean;
  canEdit: boolean;
}

/** The body of one card, by kind. */
export function CardBody(props: CardProps) {
  switch (props.card.kind) {
    case "question":
      return <QuestionCard {...props} />;
    case "transfer":
      return <TransferCard {...props} />;
    case "ird_payment":
      return <IrdCard {...props} />;
    case "duplicate":
      return <DuplicateCard {...props} />;
    case "gap":
      return <GapCard {...props} />;
    case "supply_info":
      return <SupplyInfoCard {...props} />;
    case "categorise":
      return <CategoriseCard {...props} />;
  }
}

/**
 * ADR 009's attribution for accepting an AI suggestion unchanged. Edited pre-fills, and rule or
 * history suggestions, carry none.
 */
export function viaFor(s: Suggestion): { via?: Via } {
  return s.source === "ai" && s.id && s.model ? { via: { kind: "suggestion", model: s.model, suggestion_ids: [s.id] } } : {};
}

/** Sends one command for a card; the queue refetches when it's accepted. */
function useAnswer(clientId: string) {
  const command = useCommand([keys.business(clientId)]);
  return { send: (c: Command & { via?: Via }) => command.mutate(c), busy: command.isPending, error: command.error };
}

function Lines({ lines }: { lines: CardLine[] }) {
  return (
    <ul className={styles.lines}>
      {lines.map((l) => (
        <li key={l.bank_line_id}>
          <span className={styles.lineDate}>{formatDate(l.date)}</span>
          <span className={styles.lineDesc}>
            {l.description}
            <br />
            <span className="muted">{l.account_name}</span>
          </span>
          <span className={styles.lineAmount}>
            {l.amount >= 0 ? "+" : "−"}${formatMoney(Math.abs(l.amount))}
            <br />
            <span className="muted">{l.amount >= 0 ? "money in" : "money out"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Heading({ icon, fallback, children }: { icon: string; fallback: string; children: ReactNode }) {
  return (
    <h2>
      <Icon name={icon} fallback={fallback} /> {children}
    </h2>
  );
}

function YesNo({ yes, no, onYes, onNo, busy, canEdit }: { yes: string; no: string; onYes: () => void; onNo: () => void; busy: boolean; canEdit: boolean }) {
  if (!canEdit) {
    return null;
  }
  return (
    <div className="row">
      <button type="button" className="primary" onClick={onYes} disabled={busy}>
        {yes}
      </button>
      <button type="button" onClick={onNo} disabled={busy}>
        {no}
      </button>
    </div>
  );
}

const yearLabel = (year: number) => `the year to 31 March ${year}`;

function QuestionCard({ card, clientId, canEdit }: CardProps) {
  const { send, busy, error } = useAnswer(clientId);
  const year = card.income_year ?? 0;
  const answer = (answer: Extract<Command, { kind: "answer_question" }>["payload"]["answer"]) =>
    send({ kind: "answer_question", payload: { client_id: clientId, income_year: year, answer } });

  switch (card.question) {
    case "only_income":
      return (
        <>
          <Heading icon="business.save_question" fallback="❓">
            Was this business your only income in {yearLabel(year)}?
          </Heading>
          <p className="muted">Until you tell us, we work the tax out as if you already earn enough elsewhere to pay the top rate, 39%.</p>
          <YesNo
            yes="Yes, it's my only income"
            no="No, I had other income"
            onYes={() => answer({ question: "only_income", yes: true })}
            onNo={() => answer({ question: "only_income", yes: false })}
            busy={busy}
            canEdit={canEdit}
          />
          <ErrorMessage error={error} />
        </>
      );
    case "student_loan":
      return (
        <>
          <Heading icon="business.save_question" fallback="❓">
            Did you have a student loan in {yearLabel(year)}?
          </Heading>
          <p className="muted">Until you tell us, we set aside 12% for student loan repayments.</p>
          <YesNo
            yes="No, I don't have one"
            no="Yes, I have one"
            onYes={() => answer({ question: "student_loan", yes: false })}
            onNo={() => answer({ question: "student_loan", yes: true })}
            busy={busy}
            canEdit={canEdit}
          />
          <ErrorMessage error={error} />
        </>
      );
    case "other_income":
      return <OtherIncome year={year} canEdit={canEdit} busy={busy} error={error} onAnswer={answer} />;
    case "ietc":
      return <Ietc year={year} canEdit={canEdit} busy={busy} error={error} onAnswer={answer} />;
    default:
      return <p className="muted">We can't show this question yet.</p>;
  }
}

type OnAnswer = (answer: Extract<Command, { kind: "answer_question" }>["payload"]["answer"]) => void;

function OtherIncome({ year, canEdit, busy, error, onAnswer }: { year: number; canEdit: boolean; busy: boolean; error: Error | null; onAnswer: OnAnswer }) {
  const [income, setIncome] = useState("");
  const [taxTaken, setTaxTaken] = useState("");
  const incomeCents = parseMoney(income);
  const taxCents = taxTaken.trim() === "" ? 0 : parseMoney(taxTaken);
  const valid = incomeCents !== null && incomeCents >= 0 && taxCents !== null && taxCents >= 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) {
      onAnswer({ question: "other_income", income: incomeCents, tax_deducted: taxCents });
    }
  };
  return (
    <>
      <Heading icon="business.save_question" fallback="❓">
        Your other income in {yearLabel(year)}
      </Heading>
      <p className="muted">
        Such as wages, a benefit or interest. Your payslips or myIR show the amounts before tax, and the tax taken off.
      </p>
      {canEdit && (
        <form className={styles.form} onSubmit={submit}>
          <label className="field">
            Other income, before tax ($)
            <input value={income} onChange={(e) => setIncome(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            Tax already taken off it ($)
            <input value={taxTaken} onChange={(e) => setTaxTaken(e.target.value)} inputMode="decimal" />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={!valid || busy}>
              <Icon name="business.save_ok" fallback="✅" /> Save
            </button>
          </div>
        </form>
      )}
      <ErrorMessage error={error} />
    </>
  );
}

function Ietc({ year, canEdit, busy, error, onAnswer }: { year: number; canEdit: boolean; busy: boolean; error: Error | null; onAnswer: OnAnswer }) {
  const [months, setMonths] = useState("12");
  return (
    <>
      <Heading icon="business.save_question" fallback="❓">
        The independent earner tax credit, {yearLabel(year)}
      </Heading>
      <p className="muted">
        Your income is in the range for this credit of up to $10 a week. You can't get it for a month when you got Working
        for Families, NZ Super, a main benefit or a student allowance.
      </p>
      {canEdit && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer({ question: "ietc", months: Number(months) });
          }}
        >
          <label className="field">
            How many months of the year could you get it?
            <select value={months} onChange={(e) => setMonths(e.target.value)}>
              {Array.from({ length: 13 }, (_, i) => 12 - i).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              <Icon name="business.save_ok" fallback="✅" /> Save
            </button>
          </div>
        </form>
      )}
      <ErrorMessage error={error} />
    </>
  );
}

function TransferCard({ card, clientId, canEdit }: CardProps) {
  const { send, busy, error } = useAnswer(clientId);
  const [out, inn] = card.lines;
  if (!out || !inn) {
    return null;
  }
  return (
    <>
      <Heading icon="business.save_transfer" fallback="🔁">
        Did you move this money between your own accounts?
      </Heading>
      <p className="muted">
        It left {out.account_name} and the same amount arrived in {inn.account_name}. Moving your own money isn't income, so it shouldn't be taxed.
      </p>
      <Lines lines={card.lines} />
      {canEdit && (
        <div className="row">
          <button type="button" className="primary" onClick={() => send({ kind: "confirm_transfer", payload: { out_line_id: out.bank_line_id, in_line_id: inn.bank_line_id } })} disabled={busy}>
            Yes, it's a transfer
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
    </>
  );
}

function IrdCard({ card, clientId, banks, gstRegistered, canEdit }: CardProps) {
  const { send, busy, error } = useAnswer(clientId);
  const line = card.lines[0];
  const lineYear = line ? incomeYearOf(line.date) : 0;
  const [year, setYear] = useState(String(lineYear));
  const [other, setOther] = useState(false);
  if (!line) {
    return null;
  }
  const id = line.bank_line_id;
  if (other) {
    return (
      <>
        <Heading icon="business.save_categorise" fallback="🏷️">
          What was it, then?
        </Heading>
        <Lines lines={card.lines} />
        {canEdit && <CategoriseForm card={{ ...card, suggestion: null }} clientId={clientId} banks={banks} gstRegistered={gstRegistered} />}
      </>
    );
  }
  if (line.amount > 0) {
    return (
      <>
        <Heading icon="business.save_ird" fallback="🏛️">
          Is this a GST refund from IRD?
        </Heading>
        <p className="muted">A refund of GST isn't income, so it shouldn't be taxed.</p>
        <Lines lines={card.lines} />
        <YesNo
          yes="Yes, a GST refund"
          no="No, it's something else"
          onYes={() => send({ kind: "confirm_ird_payment", payload: { bank_line_id: id, payment: { kind: "gst" } } })}
          onNo={() => setOther(true)}
          busy={busy}
          canEdit={canEdit}
        />
        <ErrorMessage error={error} />
      </>
    );
  }
  return (
    <>
      <Heading icon="business.save_ird" fallback="🏛️">
        Is this a payment to IRD?
      </Heading>
      <p className="muted">Tax you've already paid comes off what you owe, so tell us what it was for.</p>
      <Lines lines={card.lines} />
      {canEdit && (
        <div className={styles.form}>
          <div className="row">
            <button type="button" className="primary" onClick={() => send({ kind: "confirm_ird_payment", payload: { bank_line_id: id, payment: { kind: "gst" } } })} disabled={busy}>
              GST
            </button>
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => send({ kind: "confirm_ird_payment", payload: { bank_line_id: id, payment: { kind: "income_tax", income_year: Number(year) } } })}
              disabled={busy}
            >
              Income tax
            </button>
            <label>
              for{" "}
              <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Income tax for which year">
                {[lineYear + 1, lineYear, lineYear - 1, lineYear - 2].map((y) => (
                  <option key={y} value={y}>
                    {yearLabel(y)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button type="button" onClick={() => setOther(true)} disabled={busy}>
              It's not a payment to IRD
            </button>
          </div>
        </div>
      )}
      <ErrorMessage error={error} />
    </>
  );
}

function DuplicateCard({ card, clientId, canEdit }: CardProps) {
  const { send, busy, error } = useAnswer(clientId);
  const line = card.lines[0];
  if (!line) {
    return null;
  }
  const resolve = (is_duplicate: boolean) => send({ kind: "resolve_duplicate", payload: { bank_line_id: line.bank_line_id, is_duplicate } });
  return (
    <>
      <Heading icon="business.save_duplicate" fallback="👯">
        Is this the same transaction twice?
      </Heading>
      <p className="muted">
        Two of your statements both seem to have this line. If it's really one transaction, we'll count it once. If you really did it twice, we'll keep both.
      </p>
      <Lines lines={card.lines} />
      <YesNo yes="Yes, it's a duplicate" no="No, it happened twice" onYes={() => resolve(true)} onNo={() => resolve(false)} busy={busy} canEdit={canEdit} />
      <ErrorMessage error={error} />
    </>
  );
}

function GapCard({ card, clientId, banks }: CardProps) {
  const gap = card.gap;
  if (!gap) {
    return null;
  }
  const account = banks.find((b) => b.id === gap.bank_account_id)?.name ?? "one of your accounts";
  return (
    <>
      <Heading icon="business.save_gap" fallback="📭">
        A statement is missing
      </Heading>
      <p>
        We have no statement for {account} from {formatDate(gap.start)} to {formatDate(gap.end)}. The balance went up by ${formatMoney(gap.change)} over
        that time, so we count all of it as income until we can see what it was.
      </p>
      <p>
        That gap could be costing you up to <strong>${formatMoney(card.saving)}</strong> in tax. Upload the statement for those dates and we'll sort it out.
      </p>
      <Link to={`/businesses/${clientId}`}>
        <Icon name="business.upload" fallback="📤" /> Upload the missing statement
      </Link>
    </>
  );
}

function SupplyInfoCard({ card, clientId, banks, canEdit }: CardProps) {
  const { send, busy, error } = useAnswer(clientId);
  const chart = useChart(clientId);
  const line = card.lines[0];
  if (!line) {
    return null;
  }
  return (
    <>
      <Heading icon="business.save_supply" fallback="🧾">
        Do you have the tax invoice for this?
      </Heading>
      <p className="muted">
        For spending over $200, you can claim the GST back only once you have the supplier's tax invoice: a receipt or invoice with their GST number.
        Keep it for seven years.
      </p>
      <Lines lines={card.lines} />
      {card.suggestion && <p>Sorted as: {describeCoding(card.suggestion.coding, chart.data, banks)}</p>}
      {canEdit && (
        <div className="row">
          <button type="button" className="primary" onClick={() => send({ kind: "confirm_supply_info", payload: { bank_line_id: line.bank_line_id } })} disabled={busy}>
            Yes, I have it
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
    </>
  );
}

function CategoriseCard({ card, clientId, banks, gstRegistered, canEdit }: CardProps) {
  const chart = useChart(clientId);
  const { send, busy, error } = useAnswer(clientId);
  const [changing, setChanging] = useState(false);
  const line = card.lines[0];
  if (!line) {
    return null;
  }
  const suggestion = card.suggestion;
  return (
    <>
      <Heading icon="business.save_categorise" fallback="🏷️">
        {line.amount >= 0 ? "What was this money?" : "What was this spending?"}
      </Heading>
      <p className="muted">
        {line.amount >= 0
          ? "Until you tell us, we count it as income the business earned."
          : "Until you tell us, it doesn't count as a business cost, so it brings nothing off your tax."}
      </p>
      <Lines lines={card.lines} />
      {suggestion && !changing ? (
        <>
          <p className={styles.suggestion}>
            <Icon name="business.save_suggest" fallback="💡" /> We think it's: <strong>{describeCoding(suggestion.coding, chart.data, banks)}</strong>
            <br />
            <span className="muted">
              {suggestion.source === "ai"
                ? "Suggested by AI from the description and amount. Check it before you accept."
                : suggestion.source === "rule"
                  ? "One of your rules says so."
                  : suggestion.source === "merchant"
                    ? "Your accountant's list of common businesses says so."
                    : "You sorted the same description this way before."}
            </span>
          </p>
          {canEdit && (
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  send({ kind: "code_bank_line", payload: { bank_line_id: line.bank_line_id, coding: suggestion.coding }, ...viaFor(suggestion) })
                }
                disabled={busy}
              >
                Yes, that's right
              </button>
              <button type="button" onClick={() => setChanging(true)} disabled={busy}>
                No, it's something else
              </button>
            </div>
          )}
          <ErrorMessage error={error} />
        </>
      ) : (
        canEdit && <CategoriseForm card={card} clientId={clientId} banks={banks} gstRegistered={gstRegistered} />
      )}
    </>
  );
}
