/** The drag type a card carries, so a drop zone can tell an example from a file. */
export const EXAMPLE_DRAG_TYPE = "application/x-acct-example";

interface DragData {
  types?: ArrayLike<string> | readonly string[];
  files?: ArrayLike<File> | null;
  getData?: (type: string) => string;
}

/** What a drop carries: an example's number or the first file. */
export type Dropped = { kind: "example"; n: number } | { kind: "file"; file: File } | null;

export function dragHasPayload(dt: DragData | null | undefined): boolean {
  if (!dt?.types) return false;
  return Array.from(dt.types).some((t) => t === "Files" || t === EXAMPLE_DRAG_TYPE);
}

export function readDrop(dt: DragData | null | undefined): Dropped {
  if (!dt) return null;
  const raw = dt.getData?.(EXAMPLE_DRAG_TYPE);
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 3) return { kind: "example", n };
  }
  const file = dt.files?.[0];
  return file ? { kind: "file", file } : null;
}
