import { useId, useRef, useState } from "react";
import { Emoji, Icon } from "../../lib/icons";
import { Button } from "../../ui";
import { dragHasPayload, readDrop } from "./dnd";
import styles from "./TryIt.module.css";

export interface UploadDropProps {
  onExample: (n: number) => void;
  onFile: (file: File) => void;
  /** Staging shows a warning instead of the privacy line (ADR 014, question 7). */
  stagingWarning?: boolean;
  /** A small strip for adding more statements once one is in. */
  compact?: boolean;
}

/** The Upload step's drop zone: takes a dragged example card or a file, or a chosen file. */
export function UploadDrop({ onExample, onFile, stagingWarning = false, compact = false }: UploadDropProps) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  const accept = (e: React.DragEvent) => {
    if (dragHasPayload(e.dataTransfer)) {
      e.preventDefault();
      setOver(true);
    }
  };

  return (
    <div className={styles.dropWrap}>
      <div
        className={`${styles.drop} ${compact ? styles.dropCompact : ""} ${over ? styles.dropOver : ""}`}
        data-over={over || undefined}
        data-testid="upload-drop"
        onDragEnter={accept}
        onDragOver={accept}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const d = readDrop(e.dataTransfer);
          if (d?.kind === "example") onExample(d.n);
          else if (d?.kind === "file") onFile(d.file);
        }}
      >
        <span className={styles.dropIcon}>
          <Icon name="tryit.drop" fallback="📥" />
        </span>
        <p className={styles.dropText}>{over ? "Drop it here" : compact ? "Drop more statements" : "Drag a statement here, or an example from the side"}</p>
        <Button size="sm" onClick={() => input.current?.click()} aria-describedby={hintId}>
          <Icon name="tryit.file" fallback="📂" /> Choose a file
        </Button>
        <input
          ref={input}
          type="file"
          accept=".ofx,.qfx,.qif,.csv,text/plain"
          className={styles.hiddenInput}
          aria-label="Bank statement file"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <span id={hintId} className={styles.dropHint}>
          OFX works best
        </span>
      </div>
      {stagingWarning && (
        <p className={styles.privacy}>
          <Emoji>🔒</Emoji> This is our test server. Don't upload a real statement: use an example, or a made-up file.
        </p>
      )}
    </div>
  );
}
