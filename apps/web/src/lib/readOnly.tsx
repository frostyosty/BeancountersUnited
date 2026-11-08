import { createContext, useContext } from "react";

/**
 * What the Download PDF control does in a read-only view (ADR 015, 1.1):
 * - `download`: the usual link (a claimed owner, who can read the PDF);
 * - `save_first`: a guest's own business, which needs an account first;
 * - `example`: an example business, which can't be saved at all.
 */
export type PdfMode = "download" | "save_first" | "example";

export interface ReadOnlyBooks {
  readOnly: boolean;
  pdf: PdfMode;
}

/** Not read-only: the practice's own year screens never provide the context, so they don't change. */
const PRACTICE: ReadOnlyBooks = { readOnly: false, pdf: "download" };

export const ReadOnlyContext = createContext<ReadOnlyBooks>(PRACTICE);

/**
 * Whether the year screens are being shown read-only (the owner's and guest's accountant view). A
 * tab leaves its write controls out when `readOnly` is set. The server's refusals are the real
 * control; this only keeps dead buttons off the screen.
 */
export function useReadOnly(): ReadOnlyBooks {
  return useContext(ReadOnlyContext);
}
