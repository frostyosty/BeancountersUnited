import type { StarterSet } from "@acct/types/StarterSet";

/** An entity type as people say it: "sole_trader" is "sole trader". */
export const entityLabel = (entityType: string) => entityType.replace(/_/g, " ");

/** The starter sets the server ships (`crates/server/src/starter.rs`), named by entity type. */
export const STARTER_SETS: { set: StarterSet; title: string; description: string }[] = [
  {
    set: "company",
    title: "Company",
    description:
      "A company chart of accounts, a statement template and mapping that lay it out, and asset classes for plant and motor vehicles.",
  },
  {
    set: "sole_trader",
    title: "Sole trader",
    description:
      "The chart that bank coding and Save tax use for self-employed people, its statement template and mapping, and asset classes for tools, vehicles, computers and furniture.",
  },
];
