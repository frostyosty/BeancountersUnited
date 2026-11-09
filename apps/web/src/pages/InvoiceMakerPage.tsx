import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ErrorMessage } from "../components/ErrorMessage";
import { SiteHeader } from "../components/SiteHeader";
import { submitCommand } from "../lib/api";
import { Emoji, Icon } from "../lib/icons";
import { type InvoiceEditor, type SaveState, mountInvoiceEditor, sampleInvoice } from "../lib/invoiceEditor";
import {
  clearLocalInvoiceDraft,
  fetchInvoiceTemplate,
  invoiceKeys,
  localInvoiceImage,
  moveImagesToAccount,
  readLocalInvoiceDraft,
  saveInvoiceDraft,
  saveLocalInvoiceDraft,
  sanitizeInvoiceHtml,
  uploadInvoiceImage,
  useInvoiceDraft,
  useInvoiceTemplates,
} from "../lib/invoices";
import { Button, Notice, PageHeader, useConfirm } from "../ui";
import styles from "./InvoiceMakerPage.module.css";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Not saved yet",
  failed: "Couldn't save: your next change tries again",
};

// Without an account the draft is kept in this browser only.
const DEVICE_SAVE_LABEL: Record<SaveState, string> = {
  saved: "Kept on this device",
  saving: "Saving…",
  unsaved: "Not saved yet",
  failed: "Couldn't keep a copy on this device: your next change tries again",
};

/**
 * A free invoice maker, tucked away under Settings → Tools for anyone signed in, on any plan. Invoices
 * are saved to the user's own account (only they can see them) and aren't part of anyone's books.
 */
export function InvoiceMakerPage() {
  const draft = useInvoiceDraft();
  return (
    <>
      <PageHeader
        crumbs={[{ to: "/settings/tools", label: "Tools" }]}
        icon={<Icon name="tools.invoice" fallback="🧾" />}
        title="Invoice maker"
        subtitle="Lay out an invoice, then save it as a PDF. It's saved to your account, where only you can see it, and isn't part of your books."
      />
      {draft.isPending && <p className="muted">Opening your invoice…</p>}
      <ErrorMessage error={draft.error} />
      {draft.isSuccess && <Editor account initialHtml={draft.data.html} />}
    </>
  );
}

/**
 * The same invoice maker for anyone not signed in (a visitor or a trial). Laying out and saving as a PDF
 * need no account, so only what needs somewhere to keep things is left out: the draft stays on this
 * device, and saved templates ask for an account.
 */
export function PublicInvoiceMakerPage() {
  // Read once, when the page opens: the editor owns the draft from then on.
  const [initialHtml] = useState(readLocalInvoiceDraft);
  return (
    <>
      <SiteHeader />
      <main className="page">
        <PageHeader
          icon={<Icon name="tools.invoice" fallback="🧾" />}
          title="Invoice maker"
          subtitle="Lay out an invoice, then save it as a PDF. No account needed. Your invoice is kept on this device only, and isn't part of any books."
        />
        <Editor account={false} initialHtml={initialHtml} />
      </main>
    </>
  );
}

function Editor({ account, initialHtml }: { account: boolean; initialHtml: string | null }) {
  const qc = useQueryClient();
  const page = useRef<HTMLDivElement>(null);
  const editor = useRef<InvoiceEditor | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const templates = useInvoiceTemplates(account);
  const saveLabel = account ? SAVE_LABEL : DEVICE_SAVE_LABEL;
  // An invoice made on this device before signing in: offered once, never moved without asking (this may be a shared browser).
  const [offer, setOffer] = useState(() => (account ? readLocalInvoiceDraft()?.trim() || null : null));
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chosen, setChosen] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "warn" } | null>(null);
  const [busy, setBusy] = useState<"pdf" | "template" | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Mounted once: the editor owns the page from here, and saves it as it changes.
  const start = useRef(initialHtml);
  useEffect(() => {
    if (!page.current) return;
    const instance = mountInvoiceEditor({
      page: page.current,
      initialHtml: start.current,
      saveDraft: account ? saveInvoiceDraft : saveLocalInvoiceDraft,
      uploadImage: account ? uploadInvoiceImage : localInvoiceImage,
      notify: (text, tone) => setMessage({ text, tone }),
      onHistoryChange: (canUndo, canRedo) => setHistory({ canUndo, canRedo }),
      onSaveState: setSaveState,
    });
    editor.current = instance;
    return () => {
      instance.destroy();
      editor.current = null;
    };
  }, [account]);

  const list = templates.data ?? [];
  const chosenName = list.find((t) => t.id === chosen)?.name ?? "";

  /** Runs one template action, showing what went wrong if it fails. */
  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy("template");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  };

  /** Brings the invoice made on this device into the account: its images are uploaded, then it replaces the page (undoable). */
  const moveDeviceDraft = () =>
    run(async () => {
      if (!offer || !editor.current) return;
      const html = await moveImagesToAccount(sanitizeInvoiceHtml(offer), uploadInvoiceImage);
      editor.current.replace(html);
      clearLocalInvoiceDraft();
      setOffer(null);
      setMessage({ text: "Moved the invoice from this device into your account. You can undo it.", tone: "info" });
    });

  const dropDeviceDraft = () => {
    clearLocalInvoiceDraft();
    setOffer(null);
  };

  const exportPdf = async () => {
    setBusy("pdf");
    try {
      await editor.current?.exportPdf();
    } finally {
      setBusy(null);
    }
  };

  const saveTemplate = () =>
    run(async () => {
      const current = editor.current;
      const trimmed = name.trim();
      if (!current || !trimmed) return;
      const clash = list.some((t) => t.name === trimmed);
      if (
        clash &&
        !(await confirm({
          title: "Replace this template?",
          children: `There's already a template called "${trimmed}". Saving replaces it with this invoice.`,
          confirmLabel: "Replace it",
        }))
      ) {
        return;
      }
      const accepted = await submitCommand({
        kind: "save_invoice_template",
        payload: { name: trimmed, html: current.html() },
      });
      await qc.invalidateQueries({ queryKey: invoiceKeys.templates });
      setChosen(accepted.entity_id ?? "");
      setName("");
      setMessage({ text: `Saved the template "${trimmed}".`, tone: "info" });
    });

  const loadTemplate = () =>
    run(async () => {
      if (
        !chosen ||
        !(await confirm({
          title: `Load "${chosenName}"?`,
          children: "This replaces the invoice you're working on. You can undo it straight afterwards.",
          confirmLabel: "Load template",
        }))
      ) {
        return;
      }
      const template = await fetchInvoiceTemplate(chosen);
      editor.current?.replace(template.html);
    });

  const deleteTemplate = () =>
    run(async () => {
      if (
        !chosen ||
        !(await confirm({
          title: `Delete "${chosenName}"?`,
          children: "The template is deleted for good. The invoice you're working on stays as it is.",
          confirmLabel: "Delete template",
          tone: "danger",
        }))
      ) {
        return;
      }
      await submitCommand({ kind: "delete_invoice_template", payload: { template_id: chosen } });
      await qc.invalidateQueries({ queryKey: invoiceKeys.templates });
      setMessage({ text: `Deleted the template "${chosenName}".`, tone: "info" });
      setChosen("");
    });

  const startAgain = async () => {
    if (
      await confirm({
        title: "Start again from the sample?",
        children: "This replaces the invoice you're working on with the sample. You can undo it straight afterwards.",
        confirmLabel: "Start again",
      })
    ) {
      editor.current?.replace(sampleInvoice(new Date()));
    }
  };

  return (
    <>
      <div className={styles.toolbar} role="toolbar" aria-label="Invoice tools">
        <div className={styles.group}>
          <Button size="sm" onClick={() => editor.current?.add("text")}>
            <Emoji>⏳️</Emoji> Text
          </Button>
          <Button size="sm" onClick={() => editor.current?.add("image")}>
            <Emoji>🖼️</Emoji> Image
          </Button>
          <Button size="sm" onClick={() => editor.current?.add("items-table")}>
            <Emoji>📋</Emoji> Table
          </Button>
          <Button size="sm" onClick={() => editor.current?.add("line")}>
            <Emoji>➖</Emoji> Line
          </Button>
        </div>
        <div className={styles.group}>
          <Button size="sm" variant="ghost" disabled={!history.canUndo} onClick={() => editor.current?.undo()}>
            <Emoji>↩️</Emoji> Undo
          </Button>
          <Button size="sm" variant="ghost" disabled={!history.canRedo} onClick={() => editor.current?.redo()}>
            <Emoji>↪️</Emoji> Redo
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void startAgain()}>
            <Emoji>🔁</Emoji> Start again
          </Button>
        </div>
        {account ? (
          <div className={styles.group}>
            <label className={styles.inline}>
              <span className={styles.srOnly}>Template name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" maxLength={60} />
            </label>
            <Button size="sm" onClick={() => void saveTemplate()} disabled={!name.trim() || busy === "template"}>
              <Emoji>💾</Emoji> Save template
            </Button>
            <label className={styles.inline}>
              <span className={styles.srOnly}>Saved templates</span>
              <select value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={list.length === 0}>
                <option value="">{list.length ? "Choose a template…" : "No saved templates"}</option>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={!chosen || busy === "template"} onClick={() => void loadTemplate()}>
              <Emoji>📂</Emoji> Load
            </Button>
            <Button size="sm" variant="danger" disabled={!chosen || busy === "template"} onClick={() => void deleteTemplate()}>
              <Emoji>🗑️</Emoji> Delete template
            </Button>
          </div>
        ) : (
          <div className={styles.group}>
            <span className="muted">
              <Emoji>🔒</Emoji> Saved templates need a free account. <Link to="/#signin">Sign in</Link>
            </span>
          </div>
        )}
        <div className={styles.group}>
          <span className={`muted ${styles.saveState}`} role="status" aria-label="Save status">
            <Emoji>{saveState === "failed" ? "⚠️" : saveState === "saved" ? (account ? "☁️" : "💾") : "⏳"}</Emoji>{" "}
            {saveLabel[saveState]}
          </span>
          <Button variant="primary" size="sm" busy={busy === "pdf"} onClick={() => void exportPdf()}>
            <Emoji>📄</Emoji> {busy === "pdf" ? "Making PDF…" : "Save as PDF"}
          </Button>
        </div>
      </div>

      <ErrorMessage error={error ?? templates.error} />
      {offer && (
        <div className={styles.message}>
          <Notice tone="info" role="status">
            <Emoji>💾</Emoji> You made an invoice on this device before signing in. Move it into your account? It
            replaces the one on the page (you can undo that).{" "}
            <Button size="sm" variant="primary" disabled={busy === "template"} onClick={() => void moveDeviceDraft()}>
              Use that invoice
            </Button>{" "}
            <Button size="sm" variant="ghost" onClick={dropDeviceDraft}>
              Throw it away
            </Button>
          </Notice>
        </div>
      )}
      {message && (
        <div className={styles.message}>
          <Notice tone={message.tone} role={message.tone === "warn" ? "alert" : "status"}>
            {message.text}{" "}
            <Button size="sm" variant="ghost" onClick={() => setMessage(null)}>
              Dismiss
            </Button>
          </Notice>
        </div>
      )}

      <p className={`muted ${styles.hint}`}>
        <Emoji>✨️</Emoji> Click any text to edit it. Drag a block to move it, and drag its edges to resize. Arrow keys
        nudge the selected block; Delete removes it.
      </p>

      <div className={styles.desk}>
        <div ref={page} className={styles.paper} data-testid="invoice-page" />
      </div>
      {confirmDialog}
    </>
  );
}
