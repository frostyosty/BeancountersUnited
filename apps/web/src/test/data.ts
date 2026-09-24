import type { ClientDetail } from "@acct/types/ClientDetail";
import type { Me } from "@acct/types/Me";
import type { PracticeView } from "@acct/types/PracticeView";

export const boss: Me = { id: "u0", username: "boss", display_name: "Bo Boss", role: "master" };
export const sam: Me = { id: "u1", username: "sam", display_name: "Sam Staff", role: "staff" };
export const val: Me = { id: "u2", username: "val", display_name: "Val Viewer", role: "viewer" };

export const practice: PracticeView = {
  name: "Example Practice",
  master_charts: [
    {
      id: "mc1",
      entity_type: "company",
      name: "Company chart",
      accounts: [
        { code: "100", name: "Sales", account_type: "income", active: true },
        { code: "800", name: "Share capital", account_type: "equity", active: true },
        { code: "810", name: "Retained earnings", account_type: "equity", active: true },
        { code: "820", name: "Old reserve", account_type: "equity", active: false },
      ],
    },
  ],
  templates: [{ id: "t1", entity_type: "company", name: "Company", latest_version: 1 }],
  mappings: [
    { id: "m1", entity_type: "company", template_id: "t1", name: "Standard", latest_version: 2 },
    { id: "m2", entity_type: "company", template_id: "t1", name: "Alternative", latest_version: 1 },
  ],
};

export const widgets: ClientDetail = {
  id: "c1",
  name: "Example Widgets Ltd",
  entity_type: "company",
  retained_earnings: "810",
  rounding_priority: [],
  years: [
    { id: "y1", client_id: "c1", start: "2024-04-01", end: "2025-03-31", status: "open", books_source: "tb_import" },
  ],
};
