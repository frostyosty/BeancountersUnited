import type { Mapping } from "@acct/types/Mapping";
import type { PracticeView } from "@acct/types/PracticeView";
import type { Template } from "@acct/types/Template";
import type { TemplateDetail } from "@acct/types/TemplateDetail";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { AccountTable, AddAccountForm, type ChartCommands } from "../components/AccountEditor";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson, submitCommand } from "../lib/api";
import { entityLabel } from "../lib/entityTypes";
import { Icon } from "../lib/icons";
import { keys, usePractice } from "../lib/queries";
import { useCommand } from "../lib/useCommand";

/** The commands that edit one entity type's master chart. */
function masterCommands(entity_type: string): ChartCommands {
  return {
    rename: (code, name) => ({ kind: "rename_master_account", payload: { entity_type, code, name } }),
    setGst: (code, default_gst) => ({ kind: "set_master_account_gst", payload: { entity_type, code, default_gst } }),
    setActive: (code, active) => ({ kind: "set_master_account_active", payload: { entity_type, code, active } }),
    add: (account) => ({ kind: "add_master_account", payload: { entity_type, account } }),
    invalidates: [keys.practice],
  };
}

/** A practice master chart: the chart each new client of its entity type starts with a copy of. */
export function MasterChartPage() {
  const { entityType = "" } = useParams();
  const me = useCurrentUser();
  const practice = usePractice();
  if (!can(me, "practice_admin")) {
    return <p>Only practice admins can change practice settings.</p>;
  }
  if (practice.error) {
    return <ErrorMessage error={practice.error} />;
  }
  if (!practice.data) {
    return <p className="muted">Loading…</p>;
  }
  const chart = practice.data.master_charts.find((c) => c.entity_type === entityType);
  const crumbs = (
    <p className="crumbs">
      <Link to="/settings">Practice settings</Link> /
    </p>
  );
  if (!chart) {
    return (
      <>
        {crumbs}
        <p>There's no {entityLabel(entityType)} master chart.</p>
      </>
    );
  }
  const commands = masterCommands(chart.entity_type);
  return (
    <>
      {crumbs}
      <h1>
        <Icon name="defaults.chart" fallback="🗂️" /> {chart.name} master chart
      </h1>
      <p className="muted">
        Each new {entityLabel(chart.entity_type)} client starts with a copy of this chart. Changing it never alters a
        client already set up: change theirs on the client's own chart page.
      </p>
      <StatementLayout practice={practice.data} entityType={chart.entity_type} chartName={chart.name} />
      <AccountTable accounts={chart.accounts} editable commands={commands} />
      <AddAccountForm commands={commands} />
    </>
  );
}

/** The entity type's statement templates and mappings, or setting them up when there are none. */
function StatementLayout({ practice, entityType, chartName }: { practice: PracticeView; entityType: string; chartName: string }) {
  const navigate = useNavigate();
  const addMapping = useCommand([keys.practice]);
  const templates = practice.templates.filter((t) => t.entity_type === entityType);
  if (templates.length === 0) {
    return <SetUpStatements practice={practice} entityType={entityType} chartName={chartName} />;
  }
  return (
    <section className="card">
      <h2>
        <Icon name="layouts.statements" fallback="📑" /> Statements
      </h2>
      <ul>
        {templates.map((t) => {
          const mappings = practice.mappings.filter((m) => m.template_id === t.id);
          return (
            <li key={t.id}>
              <Link to={`/settings/templates/${t.id}`}>
                <Icon name="layouts.template" fallback="🧱" /> {t.name}
              </Link>{" "}
              <span className="muted">template v{t.latest_version}</span>
              {mappings.map((m) => (
                <span key={m.id}>
                  {" · "}
                  <Link to={`/settings/mappings/${m.id}`}>
                    <Icon name="layouts.mapping" fallback="🔗" /> {m.name}
                  </Link>{" "}
                  <span className="muted">mapping v{m.latest_version}</span>
                </span>
              ))}
              {mappings.length === 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    disabled={addMapping.isPending}
                    onClick={() =>
                      addMapping.mutate(
                        { kind: "create_mapping", payload: { template_id: t.id, name: t.name, body: { ranges: [] } } },
                        { onSuccess: (a) => void navigate(`/settings/mappings/${a.entity_id}`) },
                      )
                    }
                  >
                    Add a mapping
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorMessage error={addMapping.error} />
    </section>
  );
}

/**
 * A new entity type's first template and mapping: copies of another type's, or blank. Its clients
 * can add years once both exist.
 */
function SetUpStatements({ practice, entityType, chartName }: { practice: PracticeView; entityType: string; chartName: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [from, setFrom] = useState(practice.templates[0]?.id ?? "");
  const [name, setName] = useState(`${chartName} (standard)`);
  const setUp = useMutation<string, Error>({
    mutationFn: async () => {
      const title = name.trim();
      let body: Template = { name: title, statements: [], checks: [] };
      let mapping: Mapping = { ranges: [] };
      if (from) {
        const source = await getJson<TemplateDetail>(`/api/templates/${from}`);
        body = { ...source.body, name: title };
        mapping = source.mappings[0]?.body ?? mapping;
      }
      const template = await submitCommand({ kind: "create_template", payload: { entity_type: entityType, name: title, body } });
      const templateId = template.entity_id!;
      await submitCommand({ kind: "create_mapping", payload: { template_id: templateId, name: title, body: mapping } });
      return templateId;
    },
    onSuccess: async (templateId) => {
      await qc.invalidateQueries({ queryKey: keys.practice });
      void navigate(`/settings/templates/${templateId}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setUp.mutate();
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>
        <Icon name="layouts.statements" fallback="📑" /> Set up statements
      </h2>
      <p className="muted">
        {entityLabel(entityType)} clients need a statement template, and a mapping from account codes to its lines,
        before their first year can be added.
      </p>
      <div className="row">
        <label className="field">
          <span>Template name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Start from</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {practice.templates.map((t) => (
              <option key={t.id} value={t.id}>
                A copy of {t.name} ({entityLabel(t.entity_type)}), with its mapping
              </option>
            ))}
            <option value="">A blank template and mapping</option>
          </select>
        </label>
      </div>
      <ErrorMessage error={setUp.error} />
      <div>
        <button type="submit" className="primary" disabled={setUp.isPending}>
          Set up statements
        </button>
      </div>
    </form>
  );
}
