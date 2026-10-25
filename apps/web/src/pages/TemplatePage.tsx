import type { Mapping } from "@acct/types/Mapping";
import type { MappingRevision } from "@acct/types/MappingRevision";
import type { Node } from "@acct/types/Node";
import type { Presentation } from "@acct/types/Presentation";
import type { Template } from "@acct/types/Template";
import type { TemplateDetail } from "@acct/types/TemplateDetail";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { entityLabel } from "../lib/entityTypes";
import { Icon } from "../lib/icons";
import { keys, useTemplate } from "../lib/queries";
import {
  allRows,
  brokenRanges,
  canIndent,
  canOutdent,
  earlierInStatement,
  earlierStatements,
  indentNode,
  insertNode,
  keyFor,
  lineOptions,
  moveNode,
  type NodeKind,
  newNode,
  outdentNode,
  type Path,
  removeNode,
  type RowOption,
  updateNode,
} from "../lib/templateEdit";
import { useCommand } from "../lib/useCommand";
import styles from "./TemplatePage.module.css";

const KINDS: { kind: NodeKind; label: string }[] = [
  { kind: "line", label: "Line (accounts map here)" },
  { kind: "group", label: "Group (a heading over rows)" },
  { kind: "total", label: "Total (adds up earlier rows)" },
  { kind: "link", label: "Link (repeats an earlier statement's row)" },
];

const KIND_LABEL: Record<NodeKind, string> = { line: "Line", group: "Group", total: "Total", link: "Link" };

/** A statement template: its statements, their rows, and the checks that must agree. */
export function TemplatePage() {
  const { templateId = "" } = useParams();
  const me = useCurrentUser();
  const detail = useTemplate(templateId);
  if (!can(me, "practice_admin")) {
    return <p>Only practice admins can change practice settings.</p>;
  }
  if (detail.error) {
    return <ErrorMessage error={detail.error} />;
  }
  if (!detail.data) {
    return <p className="muted">Loading…</p>;
  }
  // Remount on each saved version, so the draft starts again from it.
  return <Editor key={detail.data.version} detail={detail.data} />;
}

/** What the editor needs to know everywhere. */
interface Ctx {
  t: Template;
  set: (t: Template) => void;
}

function Editor({ detail }: { detail: TemplateDetail }) {
  const [draft, setDraft] = useState<Template | null>(null);
  const [reassign, setReassign] = useState<Record<string, string>>({});
  const save = useCommand([keys.layouts, keys.practice]);
  const t = draft ?? detail.body;
  const ctx: Ctx = { t, set: setDraft };
  const lines = lineOptions(t);

  // Mapping ranges pointing at lines this draft no longer has: each needs a new line, or removing.
  const broken = detail.mappings.flatMap((m) => brokenRanges(m.body, t).map((i) => ({ mapping: m, i })));
  const unresolved = broken.filter(({ mapping, i }) => !reassign[`${mapping.id}:${i}`]);

  const revisions = (): MappingRevision[] =>
    detail.mappings
      .filter((m) => broken.some((b) => b.mapping.id === m.id))
      .map((m) => {
        const ranges = m.body.ranges.flatMap((r, i) => {
          const choice = reassign[`${m.id}:${i}`];
          if (choice === undefined) {
            return [r];
          }
          return choice === "" ? [] : [{ ...r, line: choice }];
        });
        return { mapping_id: m.id, body: { ranges } satisfies Mapping };
      });

  const submit = () => {
    const mappings = revisions();
    save.mutate(
      {
        kind: "revise_template",
        payload: { template_id: detail.id, body: t, ...(mappings.length > 0 ? { mappings } : {}) },
      },
      {
        onSuccess: () => {
          setDraft(null);
          setReassign({});
        },
      },
    );
  };

  return (
    <>
      <p className="crumbs">
        <Link to="/settings">Practice settings</Link> /
      </p>
      <h1>
        <Icon name="layouts.template" fallback="🧱" /> {detail.name}
      </h1>
      <p className="muted">
        Statement template for {entityLabel(detail.entity_type)} clients, version {detail.version}. Saving writes version{" "}
        {detail.version + 1}. Each year keeps the version it uses until it's moved onto a newer one from its Statements
        tab.
      </p>
      {detail.mappings.length > 0 && (
        <p>
          Mappings onto it:{" "}
          {detail.mappings.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ", "}
              <Link to={`/settings/mappings/${m.id}`}>
                <Icon name="layouts.mapping" fallback="🔗" /> {m.name}
              </Link>
            </span>
          ))}
        </p>
      )}

      {t.statements.map((s, si) => (
        <section key={s.key} className={`card ${styles.statement}`}>
          <div className={styles.statementHead}>
            <input
              className={styles.title}
              aria-label={`Statement ${si + 1} title`}
              value={s.title}
              onChange={(e) => setDraft(withStatement(t, si, { ...s, title: e.target.value }))}
            />
            <span className="muted">{s.key}</span>
            <span>
              <button
                type="button"
                aria-label={`Move ${s.title} up`}
                disabled={si === 0}
                onClick={() => setDraft(swapStatements(t, si, si - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${s.title} down`}
                disabled={si === t.statements.length - 1}
                onClick={() => setDraft(swapStatements(t, si, si + 1))}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${s.title}`}
                onClick={() => setDraft({ ...t, statements: t.statements.filter((_, i) => i !== si) })}
              >
                ✕
              </button>
            </span>
          </div>
          <Rows ctx={ctx} parent={[si]} nodes={s.body} />
          <AddRow ctx={ctx} parent={[si]} where={s.title} presentation="debit_positive" />
        </section>
      ))}
      <AddStatement ctx={ctx} />
      <Checks ctx={ctx} />

      {broken.length > 0 && (
        <section className={`card ${styles.broken}`} aria-label="Ranges to point elsewhere">
          <h2>
            <Icon name="layouts.unmapped" fallback="⚠️" /> Mapped lines you've removed
          </h2>
          <p className="muted">
            These mapping ranges point at lines this version no longer has. Choose where each goes now; the mappings are
            saved with the template.
          </p>
          {broken.map(({ mapping, i }) => {
            const r = mapping.body.ranges[i]!;
            const id = `${mapping.id}:${i}`;
            return (
              <label key={id} className="field">
                <span>
                  {mapping.name}: {r.from}–{r.to} (was {r.line})
                </span>
                <select value={reassign[id] ?? "-"} onChange={(e) => setReassign({ ...reassign, [id]: e.target.value })}>
                  <option value="-" disabled>
                    Choose…
                  </option>
                  <option value="">Remove this range</option>
                  {lines.map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </section>
      )}

      <ErrorMessage error={save.error} />
      <div className={`row ${styles.actions}`}>
        <button type="button" className="primary" disabled={!draft || unresolved.length > 0 || save.isPending} onClick={submit}>
          <Icon name="layouts.save" fallback="💾" /> Save version {detail.version + 1}
        </button>
        <button
          type="button"
          disabled={!draft}
          onClick={() => {
            setDraft(null);
            setReassign({});
          }}
        >
          Discard changes
        </button>
        {unresolved.length > 0 && <span className="muted">Choose where each removed line's ranges go first.</span>}
      </div>
    </>
  );
}

function withStatement(t: Template, i: number, s: Template["statements"][number]): Template {
  return { ...t, statements: t.statements.map((x, j) => (j === i ? s : x)) };
}

function swapStatements(t: Template, i: number, j: number): Template {
  const statements = [...t.statements];
  [statements[i], statements[j]] = [statements[j]!, statements[i]!];
  return { ...t, statements };
}

function Rows({ ctx, parent, nodes }: { ctx: Ctx; parent: Path; nodes: Node[] }) {
  if (nodes.length === 0) {
    return <p className="muted">No rows yet.</p>;
  }
  return (
    <ul className={styles.rows}>
      {nodes.map((n, i) => (
        <Row key={n.key} ctx={ctx} path={[...parent, i]} node={n} last={i === nodes.length - 1} />
      ))}
    </ul>
  );
}

function Row({ ctx, path, node, last }: { ctx: Ctx; path: Path; node: Node; last: boolean }) {
  const { t, set } = ctx;
  const edit = (patch: Partial<Node>) => set(updateNode(t, path, (n) => ({ ...n, ...patch }) as Node));
  const index = path.at(-1)!;
  const name = node.label || node.key;
  return (
    <li className={styles.row}>
      <div className={styles.rowLine}>
        <span className={styles.kind}>{KIND_LABEL[node.kind]}</span>
        <input aria-label={`Label for ${node.key}`} value={node.label} onChange={(e) => edit({ label: e.target.value })} />
        <select
          aria-label={`Sign for ${node.key}`}
          value={node.presentation}
          onChange={(e) => edit({ presentation: e.target.value as Presentation })}
        >
          <option value="debit_positive">Debits positive</option>
          <option value="credit_positive">Credits positive</option>
        </select>
        <span className={styles.buttons}>
          <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => set(moveNode(t, path, -1))}>
            ↑
          </button>
          <button type="button" aria-label={`Move ${name} down`} disabled={last} onClick={() => set(moveNode(t, path, 1))}>
            ↓
          </button>
          <button
            type="button"
            aria-label={`Move ${name} into the group above`}
            disabled={!canIndent(t, path)}
            onClick={() => set(indentNode(t, path))}
          >
            →
          </button>
          <button
            type="button"
            aria-label={`Move ${name} out of its group`}
            disabled={!canOutdent(path)}
            onClick={() => set(outdentNode(t, path))}
          >
            ←
          </button>
          <button type="button" aria-label={`Remove ${name}`} onClick={() => set(removeNode(t, path))}>
            ✕
          </button>
        </span>
        <span className={`muted ${styles.key}`}>{node.key}</span>
      </div>
      {node.kind === "group" && (
        <div className={styles.extra}>
          <label>
            Total row{" "}
            <input
              aria-label={`Total label for ${node.key}`}
              placeholder="No total row"
              value={node.total_label ?? ""}
              onChange={(e) => edit({ total_label: e.target.value === "" ? null : e.target.value })}
            />
          </label>
          <Protect node={node} edit={edit} />
        </div>
      )}
      {node.kind === "total" && (
        <div className={styles.extra}>
          <AddsUp options={earlierInStatement(t, path)} of={node.of} name={node.key} onChange={(of) => edit({ of })} />
          <Protect node={node} edit={edit} />
        </div>
      )}
      {node.kind === "link" && (
        <div className={styles.extra}>
          <label>
            Repeats{" "}
            <select aria-label={`${node.key} repeats`} value={node.from} onChange={(e) => edit({ from: e.target.value })}>
              {earlierStatements(t, path[0]!).map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {node.kind === "group" && (
        <div className={styles.children}>
          <Rows ctx={ctx} parent={path} nodes={node.children} />
          <AddRow ctx={ctx} parent={path} where={name} presentation={node.presentation} />
        </div>
      )}
    </li>
  );
}

/** Which earlier rows a total adds up. */
function AddsUp({
  options,
  of,
  name,
  onChange,
}: {
  options: RowOption[];
  of: string[];
  name: string;
  onChange: (of: string[]) => void;
}) {
  const labels = new Map(options.map((o) => [o.key, o.label]));
  return (
    <details className={styles.addsUp}>
      <summary>
        Adds up: {of.length === 0 ? <em>nothing yet</em> : of.map((k) => labels.get(k) ?? k).join(" + ")}
      </summary>
      {options.length === 0 && <p className="muted">There are no earlier rows in this statement.</p>}
      {options.map((o) => (
        <label key={o.key} className={styles.check}>
          <input
            type="checkbox"
            aria-label={`${name} adds ${o.key}`}
            checked={of.includes(o.key)}
            onChange={(e) =>
              onChange(e.target.checked ? options.map((x) => x.key).filter((k) => k === o.key || of.includes(k)) : of.filter((k) => k !== o.key))
            }
          />{" "}
          {o.label}
        </label>
      ))}
    </details>
  );
}

/** The rounding priority of a key total (`docs/domain.md`, Rounding): lower numbers win. */
function Protect({ node, edit }: { node: Node & { protect: number | null }; edit: (patch: Partial<Node>) => void }) {
  return (
    <label title="Rounding keeps this total equal to its exact amount, rounded. Lower numbers win when two conflict.">
      Keep exact when rounding, priority{" "}
      <input
        type="number"
        min={0}
        max={255}
        className={styles.small}
        aria-label={`Rounding priority for ${node.key}`}
        placeholder="—"
        value={node.protect ?? ""}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          edit({ protect: Number.isNaN(n) ? null : Math.min(255, Math.max(0, n)) });
        }}
      />
    </label>
  );
}

function AddRow({ ctx, parent, where, presentation }: { ctx: Ctx; parent: Path; where: string; presentation: Presentation }) {
  const [kind, setKind] = useState<NodeKind>("line");
  const [label, setLabel] = useState("");
  const links = earlierStatements(ctx.t, parent[0]!);
  const kinds = KINDS.filter((k) => k.kind !== "link" || links.length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = label.trim();
    const node = newNode(kind, keyFor(ctx.t, text), text, presentation, links[0]?.key ?? "");
    ctx.set(insertNode(ctx.t, parent, node));
    setLabel("");
  };
  return (
    <form className={styles.addRow} onSubmit={submit} aria-label={`Add a row to ${where}`}>
      <select aria-label={`New row type in ${where}`} value={kind} onChange={(e) => setKind(e.target.value as NodeKind)}>
        {kinds.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <input aria-label={`New row label in ${where}`} placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
      <button type="submit">
        <Icon name="layouts.add_row" fallback="➕" /> Add row
      </button>
    </form>
  );
}

function AddStatement({ ctx }: { ctx: Ctx }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className={`card ${styles.addRow}`}
      onSubmit={(e) => {
        e.preventDefault();
        const text = title.trim();
        const key = keyFor(ctx.t, text, "statement");
        ctx.set({ ...ctx.t, statements: [...ctx.t.statements, { key, title: text, body: [] }] });
        setTitle("");
      }}
    >
      <input aria-label="New statement title" placeholder="e.g. Statement of financial position" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <button type="submit">
        <Icon name="layouts.statements" fallback="📑" /> Add statement
      </button>
    </form>
  );
}

/** Pairs of rows whose shown amounts must agree, such as net assets and total equity. */
function Checks({ ctx }: { ctx: Ctx }) {
  const { t, set } = ctx;
  const rows = allRows(t);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const labels = new Map(rows.map((r) => [r.key, r.label]));
  return (
    <section className="card">
      <h2>
        <Icon name="layouts.check" fallback="⚖️" /> Checks
      </h2>
      <p className="muted">Rows whose amounts must agree once rounded. The statements warn when they don't.</p>
      {t.checks.length === 0 ? (
        <p className="muted">No checks.</p>
      ) : (
        <ul className={styles.rows}>
          {t.checks.map((c, i) => (
            <li key={`${c.left}=${c.right}`} className={styles.rowLine}>
              <span>
                {labels.get(c.left) ?? c.left} = {labels.get(c.right) ?? c.right}
              </span>
              <button
                type="button"
                aria-label={`Remove check ${c.left} = ${c.right}`}
                onClick={() => set({ ...t, checks: t.checks.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <select aria-label="Check left" value={left} onChange={(e) => setLeft(e.target.value)}>
          <option value="">Choose a row…</option>
          {rows.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <span>=</span>
        <select aria-label="Check right" value={right} onChange={(e) => setRight(e.target.value)}>
          <option value="">Choose a row…</option>
          {rows.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!left || !right || left === right}
          onClick={() => {
            set({ ...t, checks: [...t.checks, { left, right }] });
            setLeft("");
            setRight("");
          }}
        >
          Add check
        </button>
      </div>
    </section>
  );
}
