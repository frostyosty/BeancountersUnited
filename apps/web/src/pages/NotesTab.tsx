import type { LibraryParagraph } from "@acct/types/LibraryParagraph";
import type { Placement } from "@acct/types/Placement";
import type { YearNoteView } from "@acct/types/YearNoteView";
import { type FormEvent, useState } from "react";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { Icon } from "../lib/icons";
import { keys, useParagraphLibrary, useYearNotes } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./NotesTab.module.css";
import { useYearContext } from "./YearLayout";

/** The fields a paragraph can use (acct_core::notes::Field), with what fills each one. */
export const NOTE_FIELDS: [string, string][] = [
  ["business_name", "the client's name"],
  ["period_start", "the year's first day, such as 1 April 2025"],
  ["balance_date", "the year's last day, such as 31 March 2026"],
  ["depreciation_methods", "one line per asset class held in the year, with its rates"],
];

export function placementLabel(p: Placement): string {
  return p === "policy" ? "Policy, in note 1" : "Note of its own";
}

/**
 * A year's notes: its own copies of library paragraphs, in order. Changing the library never
 * changes them (`docs/domain.md`, "Accounting policies and notes"); the Statements tab shows them
 * filled in.
 */
export function NotesTab() {
  const { year, client } = useYearContext();
  const me = useCurrentUser();
  const notes = useYearNotes(year.id);
  const library = useParagraphLibrary(client.entity_type);
  // A year's notes change its notes and its report.
  const command = useCommand([keys.year(year.id)]);
  const [editing, setEditing] = useState<string | null>(null);
  const open = year.status === "open";
  const canEdit = can(me, "staff") && open;

  const error = notes.error ?? library.error;
  if (error) {
    return <ErrorMessage error={error} />;
  }
  if (!notes.data || !library.data) {
    return <p className="muted">Loading the notes…</p>;
  }
  const picked = notes.data.map((n) => n.paragraph_id);
  const pick = (paragraph_ids: string[]) =>
    command.mutate({ kind: "pick_notes", payload: { client_year_id: year.id, paragraph_ids } });
  const move = (i: number, by: number) => {
    const ids = [...picked];
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    pick(ids);
  };
  const unpicked = library.data.filter((p) => !picked.includes(p.id));

  return (
    <div className={styles.page}>
      <p className="muted">
        These are this year's own copies of the practice's paragraphs. Editing the library doesn't change them. Policies go
        in note 1 in this order, and each other note is numbered after it. The Statements tab shows them filled in.
      </p>
      {!open && (
        <p role="status" className={styles.notice}>
          This year is finalised, so its notes stay as they were signed.
        </p>
      )}
      <ErrorMessage error={command.error} />

      <h2>This year's notes</h2>
      {notes.data.length === 0 ? (
        <p className="muted">No notes picked yet.</p>
      ) : (
        <ol className={styles.list}>
          {notes.data.map((n, i) => (
            <li key={n.paragraph_id}>
              <section className={styles.card} aria-label={n.paragraph.title}>
                {editing === n.paragraph_id ? (
                  <EditNote
                    note={n}
                    pending={command.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={(title, body) =>
                      command.mutate(
                        {
                          kind: "edit_note",
                          payload: { client_year_id: year.id, paragraph_id: n.paragraph_id, title, body },
                        },
                        { onSuccess: () => setEditing(null) },
                      )
                    }
                  />
                ) : (
                  <>
                    <h3>{n.paragraph.title}</h3>
                    <p className={styles.meta}>
                      {placementLabel(n.paragraph.placement)} · <NoteStatus note={n} />
                    </p>
                    <p className={styles.body}>{n.paragraph.body}</p>
                    {canEdit && (
                      <div className="row">
                        <button type="button" disabled={command.isPending} onClick={() => setEditing(n.paragraph_id)}>
                          <Icon name="notes.edit" fallback="✏️" /> Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${n.paragraph.title} up`}
                          disabled={command.isPending || i === 0}
                          onClick={() => move(i, -1)}
                        >
                          <Icon name="notes.up" fallback="⬆️" /> Up
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${n.paragraph.title} down`}
                          disabled={command.isPending || i === notes.data.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <Icon name="notes.down" fallback="⬇️" /> Down
                        </button>
                        <button
                          type="button"
                          aria-label={`Drop ${n.paragraph.title}`}
                          disabled={command.isPending}
                          onClick={() => pick(picked.filter((id) => id !== n.paragraph_id))}
                        >
                          <Icon name="notes.remove" fallback="🗑️" /> Drop from this year
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            </li>
          ))}
        </ol>
      )}

      {canEdit && (
        <>
          <h2>
            <Icon name="notes.library" fallback="📚" /> Add from the library
          </h2>
          {unpicked.length === 0 ? (
            <p className="muted">Every paragraph in the library is already in this year.</p>
          ) : (
            <ul className={styles.library} aria-label="Library paragraphs">
              {unpicked.map((p) => (
                <LibraryRow key={p.id} paragraph={p} disabled={command.isPending} onAdd={() => pick([...picked, p.id])} />
              ))}
            </ul>
          )}
          <FieldHelp />
        </>
      )}
    </div>
  );
}

function NoteStatus({ note }: { note: YearNoteView }) {
  if (note.removed) {
    return <>removed from the library; this copy stays</>;
  }
  if (note.edited) {
    return <>edited for this client</>;
  }
  if (note.latest_version > note.from_version) {
    return (
      <>
        from library version {note.from_version}; the library now has version {note.latest_version}
      </>
    );
  }
  return <>as the library has it (version {note.from_version})</>;
}

function LibraryRow({ paragraph, disabled, onAdd }: { paragraph: LibraryParagraph; disabled: boolean; onAdd: () => void }) {
  return (
    <li>
      <button type="button" aria-label={`Add ${paragraph.paragraph.title}`} disabled={disabled} onClick={onAdd}>
        <Icon name="notes.add" fallback="➕" /> Add
      </button>{" "}
      {paragraph.paragraph.title} <span className="muted">({placementLabel(paragraph.paragraph.placement).toLowerCase()})</span>
    </li>
  );
}

function EditNote({
  note,
  pending,
  onSave,
  onCancel,
}: {
  note: YearNoteView;
  pending: boolean;
  onSave: (title: string, body: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(note.paragraph.title);
  const [body, setBody] = useState(note.paragraph.body);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(title, body);
  };
  return (
    <form className="form" onSubmit={submit} aria-label={`Edit ${note.paragraph.title}`}>
      <label className="field">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        Wording
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="muted">Only this year's copy changes, and later pushes from the library will leave it alone.</p>
      <div className="row">
        <button type="submit" className="primary" disabled={pending}>
          Save this year's copy
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What `{field}`s mean. Shared with the library page. */
export function FieldHelp() {
  return (
    <details className={styles.fields}>
      <summary>
        <Icon name="notes.fields" fallback="🧩" /> Fields you can use
      </summary>
      <ul>
        {NOTE_FIELDS.map(([name, what]) => (
          <li key={name}>
            <code>{`{${name}}`}</code>: {what}
          </li>
        ))}
      </ul>
      <p className="muted">
        Write <code>{"{{"}</code> or <code>{"}}"}</code> for a brace on its own. A blank line starts a new paragraph.
      </p>
    </details>
  );
}
