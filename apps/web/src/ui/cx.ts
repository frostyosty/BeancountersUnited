/** Joins class names, skipping the falsy ones. */
export function cx(...names: (string | false | null | undefined)[]): string | undefined {
  const joined = names.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}
