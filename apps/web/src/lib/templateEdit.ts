import type { Mapping } from "@acct/types/Mapping";
import type { Node } from "@acct/types/Node";
import type { Presentation } from "@acct/types/Presentation";
import type { Template } from "@acct/types/Template";

/**
 * Pure edits to a draft template, for the template editor. The server validates every version
 * it's sent (`acct_core::Template::validate`); these only keep the draft's shape tidy.
 *
 * A row is found by its path: the statement's index, then the index in each group's children,
 * so `[0, 2, 1]` is the second child of the third row of the first statement.
 */
export type Path = number[];

export type NodeKind = Node["kind"];

/** A row people can pick, such as for a total to add up. */
export interface RowOption {
  key: string;
  label: string;
}

function clone(t: Template): Template {
  return structuredClone(t);
}

/** The list a row lives in: a statement's body, or a group's children. */
function siblingsIn(t: Template, parent: Path): Node[] {
  const [s, ...rest] = parent;
  let list = t.statements[s!]!.body;
  for (const i of rest) {
    const n = list[i]!;
    if (n.kind !== "group") {
      throw new Error("only groups have children");
    }
    list = n.children;
  }
  return list;
}

export function getNode(t: Template, path: Path): Node {
  return siblingsIn(t, path.slice(0, -1))[path.at(-1)!]!;
}

export function updateNode(t: Template, path: Path, edit: (n: Node) => Node): Template {
  const next = clone(t);
  const list = siblingsIn(next, path.slice(0, -1));
  const i = path.at(-1)!;
  list[i] = edit(list[i]!);
  return next;
}

export function removeNode(t: Template, path: Path): Template {
  const next = clone(t);
  siblingsIn(next, path.slice(0, -1)).splice(path.at(-1)!, 1);
  return next;
}

/** Appends `node` to a statement (`parent` = `[s]`) or a group. */
export function insertNode(t: Template, parent: Path, node: Node): Template {
  const next = clone(t);
  siblingsIn(next, parent).push(node);
  return next;
}

/** Moves a row up (-1) or down (1) among its siblings. Unchanged at either end. */
export function moveNode(t: Template, path: Path, by: -1 | 1): Template {
  const next = clone(t);
  const list = siblingsIn(next, path.slice(0, -1));
  const i = path.at(-1)!;
  const j = i + by;
  if (j < 0 || j >= list.length) {
    return t;
  }
  [list[i], list[j]] = [list[j]!, list[i]!];
  return next;
}

/** Whether the row just above this one is a group it could go into. */
export function canIndent(t: Template, path: Path): boolean {
  const i = path.at(-1)!;
  return i > 0 && siblingsIn(t, path.slice(0, -1))[i - 1]!.kind === "group";
}

/** Moves a row to the end of the group just above it. */
export function indentNode(t: Template, path: Path): Template {
  if (!canIndent(t, path)) {
    return t;
  }
  const next = clone(t);
  const list = siblingsIn(next, path.slice(0, -1));
  const i = path.at(-1)!;
  const [node] = list.splice(i, 1);
  const group = list[i - 1]!;
  if (group.kind === "group") {
    group.children.push(node!);
  }
  return next;
}

/** Whether the row is inside a group (rather than at a statement's top level). */
export function canOutdent(path: Path): boolean {
  return path.length > 2;
}

/** Moves a row out of its group, to just after the group. */
export function outdentNode(t: Template, path: Path): Template {
  if (!canOutdent(path)) {
    return t;
  }
  const next = clone(t);
  const groupPath = path.slice(0, -1);
  const [node] = siblingsIn(next, groupPath).splice(path.at(-1)!, 1);
  siblingsIn(next, groupPath.slice(0, -1)).splice(groupPath.at(-1)! + 1, 0, node!);
  return next;
}

/** This row and everything under it, groups after their children (the order keys become usable). */
function postOrder(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (n.kind === "group" ? [...postOrder(n.children), n] : [n]));
}

/** Every row, groups before their children, as statements show them. */
export function walk(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (n.kind === "group" ? [n, ...walk(n.children)] : [n]));
}

/** Every key in use: statements' and rows'. Keys are unique across a template. */
export function allKeys(t: Template): Set<string> {
  return new Set([...t.statements.map((s) => s.key), ...t.statements.flatMap((s) => walk(s.body).map((n) => n.key))]);
}

/**
 * A new key from a label: lowercase letters, digits and `_`, at most 60 characters, made unique
 * with `_2`, `_3`, ... A key never changes once the row exists: mappings refer to it.
 */
export function keyFor(t: Template, label: string, fallback = "row"): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || fallback;
  const used = allKeys(t);
  if (!used.has(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const key = `${base}_${n}`;
    if (!used.has(key)) {
      return key;
    }
  }
}

/** A new row of `kind`, with nothing filled in beyond its label. */
export function newNode(kind: NodeKind, key: string, label: string, presentation: Presentation, linkFrom = ""): Node {
  switch (kind) {
    case "group":
      return { kind, key, label, presentation, children: [], total_label: null, protect: null };
    case "line":
      return { kind, key, label, presentation };
    case "total":
      return { kind, key, label, presentation, of: [], protect: null };
    case "link":
      return { kind, key, label, presentation, from: linkFrom };
  }
}

/**
 * The rows a total at `path` can add up: those earlier in its own statement. A group counts once
 * its children are done, so a total can't use a group it's inside.
 */
export function earlierInStatement(t: Template, path: Path): RowOption[] {
  const target = getNode(t, path);
  const order = postOrder(t.statements[path[0]!]!.body);
  return order.slice(0, order.indexOf(target)).map((n) => ({ key: n.key, label: n.label }));
}

/** The rows a link in statement `s` can repeat: any row of an earlier statement. */
export function earlierStatements(t: Template, s: number): RowOption[] {
  return t.statements.slice(0, s).flatMap((st) => walk(st.body).map((n) => ({ key: n.key, label: `${st.title}: ${n.label}` })));
}

/** Every row, for the balance checks. */
export function allRows(t: Template): RowOption[] {
  return t.statements.flatMap((st) => walk(st.body).map((n) => ({ key: n.key, label: `${st.title}: ${n.label}` })));
}

/** The rows accounts can map to. */
export function lineOptions(t: Template): RowOption[] {
  return t.statements.flatMap((st) =>
    walk(st.body)
      .filter((n) => n.kind === "line")
      .map((n) => ({ key: n.key, label: `${st.title}: ${n.label}` })),
  );
}

/** The indexes of a mapping's ranges that point at a line the template doesn't have. */
export function brokenRanges(mapping: Mapping, t: Template): number[] {
  const lines = new Set(lineOptions(t).map((l) => l.key));
  return mapping.ranges.flatMap((r, i) => (lines.has(r.line) ? [] : [i]));
}
