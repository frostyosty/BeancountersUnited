import type { ReactNode } from "react";
import styles from "./Field.module.css";

export interface FieldProps {
  label: ReactNode;
  /** A line of help under the control. It sits outside the label, so it doesn't become part of the control's name. */
  hint?: ReactNode;
  children: ReactNode;
}

/** A labelled form control: <Field label="Name"><input …/></Field>. The label wraps the control, so it names it. */
export function Field({ label, hint, children }: FieldProps) {
  const field = (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
  if (!hint) return field;
  return (
    <div className={styles.group}>
      {field}
      <small className={styles.hint}>{hint}</small>
    </div>
  );
}
