import type { AssetClassView } from "@acct/types/AssetClassView";
import type { MasterChartView } from "@acct/types/MasterChartView";
import type { PracticeView } from "@acct/types/PracticeView";
import type { Role } from "@acct/types/Role";
import type { UserView } from "@acct/types/UserView";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ChartPreview } from "../components/ChartPreview";
import { ErrorMessage } from "../components/ErrorMessage";
import { AssetAccountFields, DepreciationFields, NO_ACCOUNTS } from "../components/DepreciationFields";
import { DEFAULT_DRAFT, describeConventions, describeMethod, type SettingsDraft, toDraft, toSettings } from "../lib/depreciation";
import { ASSET_PRESETS, type AssetPreset, guessAccounts } from "../lib/assetPresets";
import { entityLabel, STARTER_SETS } from "../lib/entityTypes";
import { Emoji, Icon } from "../lib/icons";
import { keys, useAssetClasses, usePractice, useUsers } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./SettingsPage.module.css";

/** The Practice tab of Settings: practice admins only (the server checks too). */
export function SettingsPage() {
  const me = useCurrentUser();
  if (!can(me, "practice_admin")) {
    return <p>Only practice admins can change practice settings.</p>;
  }
  return (
    <>
      <h2>
        <Icon name="settings.practice" fallback="🏢" /> Practice
      </h2>
      <Defaults />
      <AssetClasses />
      <Users />
    </>
  );
}

function Defaults() {
  const practice = usePractice();
  if (practice.error) {
    return <ErrorMessage error={practice.error} />;
  }
  if (!practice.data) {
    return null;
  }
  const p = practice.data;
  return (
    <>
      <p>
        Practice: <strong>{p.name}</strong>
      </p>
      <h2>Defaults</h2>
      {p.master_charts.length === 0 ? (
        <p className="muted">
          <Icon name="defaults.none_yet" fallback="🌱" /> No defaults yet, so no clients can be set up. Install a starter
          set below, or make your own chart.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Entity type</th>
              <th>Master chart</th>
              <th>Templates</th>
              <th>Mappings</th>
            </tr>
          </thead>
          <tbody>
            {p.master_charts.map((c) => (
              <tr key={c.id}>
                <td>{entityLabel(c.entity_type)}</td>
                <td>
                  <Link to={`/settings/charts/${c.entity_type}`}>
                    <Icon name="defaults.chart" fallback="🗂️" /> {c.name}
                  </Link>{" "}
                  <span className="muted">({c.accounts.length} accounts)</span>
                </td>
                <td>
                  <Links
                    items={p.templates.filter((t) => t.entity_type === c.entity_type)}
                    to={(id) => `/settings/templates/${id}`}
                  />
                </td>
                <td>
                  <Links
                    items={p.mappings.filter((m) => m.entity_type === c.entity_type)}
                    to={(id) => `/settings/mappings/${id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        Open a master chart, template or mapping to edit it. Changing a default never alters existing clients: a year
        moves onto a newer template or mapping only from its own Statements tab.
      </p>
      <p>
        <Link to="/settings/paragraphs">
          <Icon name="notes.library" fallback="📚" /> Paragraph library
        </Link>{" "}
        <span className="muted">(accounting policies and notes)</span>
      </p>
      <StarterSets practice={p} />
      <NewMasterChart practice={p} />
    </>
  );
}

/** Templates or mappings, each linking to its editor, with its latest version. */
function Links({ items, to }: { items: { id: string; name: string; latest_version: number }[]; to: (id: string) => string }) {
  if (items.length === 0) {
    return <span className="muted">none yet</span>;
  }
  return items.map((item, i) => (
    <span key={item.id}>
      {i > 0 && ", "}
      <Link to={to(item.id)}>{item.name}</Link> <span className="muted">v{item.latest_version}</span>
    </span>
  ));
}

/** The starter sets not installed yet. Each sets up an entity type's defaults in one command. */
function StarterSets({ practice }: { practice: PracticeView }) {
  const install = useCommand([keys.practice, keys.assetClasses]);
  const taken = new Set([...practice.master_charts, ...practice.templates].map((d) => d.entity_type));
  const available = STARTER_SETS.filter((s) => !taken.has(s.set));
  if (available.length === 0) {
    return null;
  }
  return (
    <section className="card">
      <h2>
        <Icon name="defaults.starter" fallback="📦" /> Starter sets
      </h2>
      <p className="muted">
        Ready-made defaults for an entity type: a master chart, a statement template and mapping, and asset classes. Edit
        them afterwards to suit the practice.
      </p>
      <ErrorMessage error={install.error} />
      {available.map((s) => (
        <div key={s.set} className={styles.starter}>
          <div>
            <strong>{s.title}</strong>
            <p className="muted">{s.description}</p>
          </div>
          <button
            type="button"
            className="primary"
            aria-label={`Install the ${s.title.toLowerCase()} starter set`}
            disabled={install.isPending}
            onClick={() => install.mutate({ kind: "install_starter_set", payload: { set: s.set } })}
          >
            <Icon name="defaults.install" fallback="✨" /> Install
          </button>
        </div>
      ))}
    </section>
  );
}

/** Makes a master chart for an entity type that has none: empty, or a copy of another. */
function NewMasterChart({ practice }: { practice: PracticeView }) {
  const create = useCommand([keys.practice]);
  const navigate = useNavigate();
  const [entityType, setEntityType] = useState("");
  const [name, setName] = useState("");
  // null until the user picks: then the first chart shows, so the preview is never blank.
  const [picked, setPicked] = useState<string | null>(null);
  const from = picked ?? practice.master_charts[0]?.entity_type ?? "";
  const source = practice.master_charts.find((c) => c.entity_type === from);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const type = entityType.trim().toLowerCase().replace(/\s+/g, "_");
    const accounts = source?.accounts ?? [];
    create.mutate(
      { kind: "create_master_chart", payload: { entity_type: type, name: name.trim(), accounts } },
      { onSuccess: () => void navigate(`/settings/charts/${type}`) },
    );
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>
        <Icon name="defaults.new_chart" fallback="🆕" /> Make your own chart
      </h2>
      <div className="row">
        <label className="field">
          <span>New chart's entity type</span>
          <input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="e.g. trust" required />
        </label>
        <label className="field">
          <span>Chart name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Start from</span>
          <select value={from} onChange={(e) => setPicked(e.target.value)}>
            {practice.master_charts.map((c) => (
              <option key={c.id} value={c.entity_type}>
                A copy of {c.name} ({c.accounts.length} accounts)
              </option>
            ))}
            <option value="">An empty chart</option>
          </select>
        </label>
      </div>
      <ChartPreview chart={source} />
      <p className="muted">
        Each entity type has one master chart. Its page then sets up the statement template and mapping that clients of
        that type need before their first year can be added.
      </p>
      <ErrorMessage error={create.error} />
      <div>
        <button type="submit" className="primary" disabled={create.isPending}>
          Make chart
        </button>
      </div>
    </form>
  );
}

function Users() {
  const me = useCurrentUser();
  const users = useUsers();
  const command = useCommand([keys.users]);
  const [resetting, setResetting] = useState<string | null>(null);

  return (
    <>
      <h2>Users</h2>
      <ErrorMessage error={users.error ?? command.error} />
      {users.data && (
        <table className="table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Role</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.display_name}</td>
                <td>{u.role}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${u.username} active`}
                    checked={u.active}
                    disabled={u.id === me.id || command.isPending}
                    onChange={(e) => command.mutate({ kind: "set_user_active", payload: { user_id: u.id, active: e.target.checked } })}
                  />
                </td>
                <td>
                  {resetting === u.id ? (
                    <ResetPassword user={u} onDone={() => setResetting(null)} />
                  ) : (
                    <button type="button" onClick={() => setResetting(u.id)}>
                      Reset password…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <NewUserForm />
    </>
  );
}

function ResetPassword({ user, onDone }: { user: UserView; onDone: () => void }) {
  const reset = useCommand();
  const [password, setPassword] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        reset.mutate({ kind: "reset_password", payload: { user_id: user.id, new_password: password } }, { onSuccess: onDone });
      }}
    >
      <input
        type="password"
        aria-label={`New password for ${user.username}`}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button type="submit" className="primary" disabled={reset.isPending}>
        Set password
      </button>
      <button type="button" onClick={onDone}>
        Cancel
      </button>
      <ErrorMessage error={reset.error} />
    </form>
  );
}

function NewUserForm() {
  const create = useCommand([keys.users]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("staff");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { kind: "create_user", payload: { username: username.trim(), display_name: displayName.trim(), password, role } },
      {
        onSuccess: () => {
          setUsername("");
          setDisplayName("");
          setPassword("");
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>New user</h2>
      <div className="row">
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
        </label>
        <label className="field">
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="staff">staff</option>
            <option value="viewer">viewer</option>
            <option value="practice_admin">practice admin</option>
          </select>
        </label>
      </div>
      <ErrorMessage error={create.error} />
      <div>
        <button type="submit" className="primary" disabled={create.isPending}>
          Create user
        </button>
      </div>
    </form>
  );
}

/**
 * The practice asset classes. Editing one never changes existing assets: they carry copies, and
 * staff push a new default onto a client's assets explicitly.
 */
function AssetClasses() {
  const practice = usePractice();
  const classes = useAssetClasses();
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<"classes" | "add">("classes");
  const [preset, setPreset] = useState<AssetPreset | null>(null);
  if (!practice.data || !classes.data) {
    return <ErrorMessage error={practice.error ?? classes.error} />;
  }
  return (
    <>
      <h2>Asset classes</h2>
      <div role="tablist" aria-label="Asset classes" className={styles.tabs}>
        <button type="button" role="tab" aria-selected={tab === "classes"} onClick={() => setTab("classes")}>
          <Icon name="defaults.chart" fallback="🗂️" /> Classes ({classes.data.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "add"} onClick={() => setTab("add")}>
          <Icon name="defaults.add_account" fallback="➕" /> Add a class
        </button>
      </div>
      {tab === "add" && (
        <section className="card">
          <p className="muted">Pick a preset to start from, or choose custom. You can change anything before adding.</p>
          <div className={styles.presets}>
            {ASSET_PRESETS.map((p) => (
              <button type="button" key={p.key} aria-pressed={preset?.key === p.key} onClick={() => setPreset(p)}>
                <Emoji>{p.icon}</Emoji> {p.name} <span className="muted">{p.blurb}</span>
              </button>
            ))}
            <button type="button" aria-pressed={preset === null} onClick={() => setPreset(null)}>
              <Emoji>✏️</Emoji> Custom
            </button>
          </div>
          <AssetClassForm
            key={preset?.key ?? "custom"}
            preset={preset ?? undefined}
            charts={practice.data.master_charts}
            onDone={() => setTab("classes")}
          />
        </section>
      )}
      {tab === "classes" && (
        <>
      <table className="table">
        <thead>
          <tr>
            <th>Entity type</th>
            <th>Class</th>
            <th>Method</th>
            <th>Conventions</th>
            <th>Accounts</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {classes.data.map((c) => (
            <tr key={c.id}>
              <td>{c.entity_type}</td>
              <td>
                {c.name} <span className="muted">({c.key})</span>
              </td>
              <td>{describeMethod(c.settings)}</td>
              <td>{describeConventions(c.settings)}</td>
              <td>
                {c.accounts.cost}, {c.accounts.accumulated}, {c.accounts.expense}, {c.accounts.gain_loss}
              </td>
              <td>
                <button type="button" onClick={() => setEditing(c.id)}>
                  Edit…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {classes.data
        .filter((c) => c.id === editing)
        .map((c) => (
          <AssetClassForm
            key={c.id}
            existing={c}
            charts={practice.data.master_charts}
            onDone={() => setEditing(null)}
          />
        ))}
        </>
      )}
    </>
  );
}

function AssetClassForm({
  existing,
  preset,
  charts,
  onDone,
}: {
  existing?: AssetClassView;
  preset?: AssetPreset;
  charts: MasterChartView[];
  onDone: () => void;
}) {
  const save = useCommand([keys.assetClasses]);
  const [entityType, setEntityType] = useState(existing?.entity_type ?? charts[0]?.entity_type ?? "");
  const [key, setKey] = useState(existing?.key ?? preset?.key ?? "");
  const [name, setName] = useState(existing?.name ?? preset?.name ?? "");
  const [draft, setDraft] = useState<SettingsDraft>(existing ? toDraft(existing.settings) : (preset?.draft ?? DEFAULT_DRAFT));
  const chart = charts.find((c) => c.entity_type === entityType)?.accounts ?? [];
  const [accounts, setAccounts] = useState(existing?.accounts ?? (preset ? guessAccounts(preset, chart) : NO_ACCOUNTS));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const settings = toSettings(draft);
    if (typeof settings === "string") {
      setProblem(settings);
      return;
    }
    setProblem(null);
    const reset = () => {
      if (!existing) {
        setKey("");
        setName("");
        setDraft(DEFAULT_DRAFT);
        setAccounts(NO_ACCOUNTS);
      }
      onDone();
    };
    save.mutate(
      existing
        ? { kind: "update_asset_class", payload: { class_id: existing.id, name: name.trim(), settings, accounts } }
        : { kind: "create_asset_class", payload: { entity_type: entityType, key: key.trim(), name: name.trim(), settings, accounts } },
      { onSuccess: reset },
    );
  };

  return (
    <form onSubmit={submit} className={existing ? "card form" : "form"}>
      {existing && <h2>Edit {existing.name}</h2>}
      {existing && <p className="muted">Existing assets keep their settings until a client's defaults are applied to them.</p>}
      <div className="row">
        {!existing && (
          <>
            <label className="field">
              <span>Entity type</span>
              <select
                value={entityType}
                onChange={(e) => {
                  setEntityType(e.target.value);
                  if (preset) {
                    setAccounts(guessAccounts(preset, charts.find((c) => c.entity_type === e.target.value)?.accounts ?? []));
                  }
                }}
              >
                {charts.map((c) => (
                  <option key={c.entity_type} value={c.entity_type}>
                    {c.entity_type}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Key</span>
              <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. plant" required />
            </label>
          </>
        )}
        <label className="field">
          <span>Class name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      </div>
      <DepreciationFields draft={draft} onChange={setDraft} />
      <AssetAccountFields accounts={accounts} chart={chart} onChange={setAccounts} />
      {problem && <p role="alert">{problem}</p>}
      <ErrorMessage error={save.error} />
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>
          {existing ? "Save class" : "Add class"}
        </button>
        {existing && (
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
