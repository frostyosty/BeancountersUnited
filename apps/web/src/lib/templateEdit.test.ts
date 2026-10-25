import type { Template } from "@acct/types/Template";
import { describe, expect, it } from "vitest";
import {
  brokenRanges,
  canIndent,
  earlierInStatement,
  earlierStatements,
  getNode,
  indentNode,
  insertNode,
  keyFor,
  moveNode,
  newNode,
  outdentNode,
  removeNode,
} from "./templateEdit";

const template: Template = {
  name: "T",
  statements: [
    {
      key: "performance",
      title: "Performance",
      body: [
        {
          kind: "group",
          key: "revenue",
          label: "Revenue",
          presentation: "credit_positive",
          children: [{ kind: "line", key: "sales", label: "Sales", presentation: "credit_positive" }],
          total_label: "Total revenue",
          protect: null,
        },
        { kind: "line", key: "rent", label: "Rent", presentation: "debit_positive" },
        { kind: "total", key: "profit", label: "Profit", presentation: "credit_positive", of: ["revenue"], protect: 1 },
      ],
    },
    { key: "position", title: "Position", body: [] },
  ],
  checks: [],
};

describe("template edits", () => {
  it("never changes the template it's given", () => {
    const before = JSON.stringify(template);
    removeNode(template, [0, 1]);
    insertNode(template, [1], newNode("line", "bank", "Bank", "debit_positive"));
    moveNode(template, [0, 1], -1);
    expect(JSON.stringify(template)).toBe(before);
  });

  it("moves a row into the group above it and back out after the group", () => {
    expect(canIndent(template, [0, 1])).toBe(true);
    expect(canIndent(template, [0, 2])).toBe(false);
    const inside = indentNode(template, [0, 1]);
    expect(getNode(inside, [0, 0, 1]).key).toBe("rent");
    const out = outdentNode(inside, [0, 0, 1]);
    expect(out.statements[0]!.body.map((n) => n.key)).toEqual(["revenue", "rent", "profit"]);
  });

  it("swaps a row with its neighbour, and leaves the ends alone", () => {
    expect(moveNode(template, [0, 2], 1)).toBe(template);
    expect(moveNode(template, [0, 2], -1).statements[0]!.body.map((n) => n.key)).toEqual(["revenue", "profit", "rent"]);
  });

  it("makes unique keys from labels", () => {
    expect(keyFor(template, "Interest received")).toBe("interest_received");
    expect(keyFor(template, "Sales")).toBe("sales_2");
    expect(keyFor(template, "  — ")).toBe("row");
  });

  it("offers a total the earlier rows of its statement, and a link the earlier statements'", () => {
    expect(earlierInStatement(template, [0, 2]).map((r) => r.key)).toEqual(["sales", "revenue", "rent"]);
    // Inside the group, the group itself isn't ready yet.
    expect(earlierInStatement(template, [0, 0, 0]).map((r) => r.key)).toEqual([]);
    expect(earlierStatements(template, 1).map((r) => r.key)).toEqual(["revenue", "sales", "rent", "profit"]);
    expect(earlierStatements(template, 0)).toEqual([]);
  });

  it("finds mapping ranges whose line is gone", () => {
    const mapping = {
      ranges: [
        { from: "100", to: "199", line: "sales" },
        { from: "230", to: "239", line: "rent" },
      ],
    };
    expect(brokenRanges(mapping, template)).toEqual([]);
    expect(brokenRanges(mapping, removeNode(template, [0, 1]))).toEqual([1]);
  });
});
