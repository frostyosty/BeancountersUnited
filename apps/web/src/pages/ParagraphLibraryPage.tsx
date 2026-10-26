import type { LibraryParagraph } from "@acct/types/LibraryParagraph";
import type { Placement } from "@acct/types/Placement";
import type { PushChange } from "@acct/types/PushChange";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { formatDate } from "../lib/dates";
import { Icon } from "../lib/icons";
import { keys, useParagraphLibrary, usePractice } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { ConfirmDialog, PageHeader } from "../ui";
import { FieldHelp, placementLabel } from "./NotesTab";
import styles from "./ParagraphLibraryPage.module.css";

/** Library commands change the library, and a push changes years' notes. */
const INVALIDATES = [keys.paragraphs, keys.years];

/**
 * The practice paragraph library (M15), one per entity type: practice admins only (the server
 * checks too). Revising a paragraph changes no client's notes; pushing is the explicit step, after
 * a preview, and only reaches open years.
 */
export function ParagraphLibraryPage() {
  const me = useCurrentUser();
  const practice = usePractice();
  const [chosen, setChosen] = useState<string | null>(null);
  if (!can(me, "practice_admin")) {
    return <p>Only practice admins can change the paragraph library.</p>;
  }
  if (practice.error) {
    return <ErrorMessage error={practice.error} />;
  }
  if (!practice.data) {
    return <p className="muted">Loading…</p>;
  }
  const types = practice.data.master_charts.map((c) => c.entity_type);
  const entityType = chosen ?? (types.includes("sole_trader") ? "sole_trader" : (types[0] ?? ""));
  return (
    <>
      <PageHeader
        crumbs={[{ to: "/settings", label: "Settings" }]}
        icon={<Icon name="notes.library" fallback="📚" />}
        title="Paragraph library"
      />
      <p className="muted">
        The accounting policies and notes each client-year picks from, in our own words. A year keeps its own copies:
        changing a paragraph here changes no client's notes until you push it, and a push never reaches a finalised year
        or a copy staff have edited.
      </p>
      {types.length === 0 ? (
        <p className="muted">Add a master chart first; each entity type has its own library.</p>
      ) : (
        <>
          {types.length > 1 && (
            <label className="field">
              Entity type
              <select value={entityType} onChange={(e) => setChosen(e.target.value)}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Library entityType={entityType} />
        </>
      )}
    </>
  );
}

type Mode = { id: string; kind: "revise" | "push" | "remove" } | null;

function Library({ entityType }: { entityType: string }) {
  const library = useParagraphLibrary(entityType);
  const command = useCommand(INVALIDATES);
  const [mode, setMode] = useState<Mode>(null);
  const done = { onSuccess: () => setMode(null) };

  if (library.error) {
    return <ErrorMessage error={library.error} />;
  }
  if (!library.data) {
    return <p className="muted">Loading the library…</p>;
  }
  return (
    <>
      <ErrorMessage error={command.error} />
      {library.data.length === 0 && <p className="muted">The {entityType.replace(/_/g, " ")} library is empty.</p>}
      {library.data.map((p) => {
        const m = mode?.id === p.id ? mode.kind : null;
        return (
          <section key={p.id} className={styles.card} aria-label={p.paragraph.title}>
            <h2>{p.paragraph.title}</h2>
            <p className={styles.meta}>
              <code>{p.paragraph.key}</code> · {placementLabel(p.paragraph.placement)} · version {p.version}
            </p>
            {m === "revise" ? (
              <ParagraphForm
                label={`Revise ${p.paragraph.title}`}
                initial={p.paragraph}
                submit="Save as a new version"
                pending={command.isPending}
                onCancel={() => setMode(null)}
                onSave={({ placement, title, body }) =>
                  command.mutate({ kind: "revise_paragraph", payload: { paragraph_id: p.id, placement, title, body } }, done)
                }
              />
            ) : (
              <p className={styles.body}>{p.paragraph.body}</p>
            )}
            {m === "push" && (
              <PushPreview
                paragraph={p}
                pending={command.isPending}
                onCancel={() => setMode(null)}
                onPush={() => command.mutate({ kind: "push_paragraph", payload: { paragraph_id: p.id } }, done)}
              />
            )}
            <ConfirmDialog
              open={m === "remove"}
              title={`Remove “${p.paragraph.title}”?`}
              aria-label={`Remove ${p.paragraph.title}`}
              confirmLabel="Remove it"
              tone="danger"
              busy={command.isPending}
              onCancel={() => setMode(null)}
              onConfirm={() =>
                command.mutate({ kind: "remove_paragraph", payload: { paragraph_id: p.id } }, { onSettled: () => setMode(null) })
              }
            >
              <p>
                Remove “{p.paragraph.title}” from the library? Years that already use it keep their copies, but no year can pick
                it again.
              </p>
            </ConfirmDialog>
            {m === null && (
              <div className="row">
                <button type="button" onClick={() => setMode({ id: p.id, kind: "revise" })}>
                  <Icon name="notes.edit" fallback="✏️" /> Revise
                </button>
                <button type="button" onClick={() => setMode({ id: p.id, kind: "push" })}>
                  <Icon name="notes.push" fallback="📤" /> Push to open years…
                </button>
                <button type="button" onClick={() => setMode({ id: p.id, kind: "remove" })}>
                  <Icon name="notes.remove" fallback="🗑️" /> Remove…
                </button>
              </div>
            )}
          </section>
        );
      })}
      <AddParagraph entityType={entityType} />
      <FieldHelp />
    </>
  );
}

/** What a push would do, from the server; the push itself only applies the "update" rows. */
function PushPreview({
  paragraph,
  pending,
  onPush,
  onCancel,
}: {
  paragraph: LibraryParagraph;
  pending: boolean;
  onPush: () => void;
  onCancel: () => void;
}) {
  const preview = useQuery({
    queryKey: keys.pushPreview(paragraph.id),
    queryFn: () => getJson<PushChange[]>(`/api/paragraphs/${paragraph.id}/push-preview`),
  });
  if (preview.error) {
    return <ErrorMessage error={preview.error} />;
  }
  if (!preview.data) {
    return <p className="muted">Working out what a push would change…</p>;
  }
  const updates = preview.data.filter((c) => c.action === "update").length;
  return (
    <div className={styles.confirm}>
      {preview.data.length === 0 ? (
        <p>Every open year's copy is already at version {paragraph.version}. Finalised years are never changed.</p>
      ) : (
        <table className="table" aria-label={`Push ${paragraph.paragraph.title}`}>
          <thead>
            <tr>
              <th>Client</th>
              <th>Year ended</th>
              <th>Copy</th>
              <th>A push will</th>
            </tr>
          </thead>
          <tbody>
            {preview.data.map((c) => (
              <tr key={c.client_year_id}>
                <td>{c.client_name}</td>
                <td>{formatDate(c.year_end)}</td>
                <td>
                  version {c.from_version} to {c.to_version}
                </td>
                <td>{c.action === "update" ? "update it to the latest wording" : "keep it: edited for this client"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        {updates > 0 && (
          <button type="button" className="primary" disabled={pending} onClick={onPush}>
            Push to {updates} open {updates === 1 ? "year" : "years"}
          </button>
        )}
        <button type="button" onClick={onCancel}>
          {updates > 0 ? "Cancel" : "Close"}
        </button>
      </div>
    </div>
  );
}

type Draft = { placement: Placement; title: string; body: string };

function ParagraphForm({
  label,
  initial,
  submit,
  pending,
  onSave,
  onCancel,
}: {
  label: string;
  initial: Draft;
  submit: string;
  pending: boolean;
  onSave: (d: Draft) => void;
  onCancel?: () => void;
}) {
  const [placement, setPlacement] = useState<Placement>(initial.placement);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const save = (e: FormEvent) => {
    e.preventDefault();
    onSave({ placement, title, body });
  };
  return (
    <form className="form" onSubmit={save} aria-label={label}>
      <label className="field">
        Placement
        <select value={placement} onChange={(e) => setPlacement(e.target.value as Placement)}>
          <option value="policy">{placementLabel("policy")}</option>
          <option value="note">{placementLabel("note")}</option>
        </select>
      </label>
      <label className="field">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        Wording
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={pending}>
          {submit}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function AddParagraph({ entityType }: { entityType: string }) {
  const command = useCommand(INVALIDATES);
  const [key, setKey] = useState("");
  // Remounting the form clears it after a save.
  const [round, setRound] = useState(0);
  return (
    <section className={styles.card} aria-label="Add a paragraph">
      <h2>
        <Icon name="notes.add" fallback="➕" /> Add a paragraph
      </h2>
      <ErrorMessage error={command.error} />
      <label className="field">
        Key (lower case and underscores, such as <code>related_parties</code>; it can't change later)
        <input value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <ParagraphForm
        key={round}
        label="New paragraph"
        initial={{ placement: "note", title: "", body: "" }}
        submit="Add to the library"
        pending={command.isPending}
        onSave={(d) =>
          command.mutate(
            { kind: "add_paragraph", payload: { entity_type: entityType, paragraph: { key, ...d } } },
            {
              onSuccess: () => {
                setKey("");
                setRound((r) => r + 1);
              },
            },
          )
        }
      />
    </section>
  );
}
