import { ApiRequestError } from "../lib/api";

/** An error from a query or command, with the server's details listed when there are any. */
export function ErrorMessage({ error }: { error: Error | null }) {
  if (!error) {
    return null;
  }
  const details = error instanceof ApiRequestError && Array.isArray(error.details) ? error.details : [];
  return (
    <div role="alert" className="error">
      <p className="error">{error.message}</p>
      {details.length > 0 && (
        <ul>
          {details.map((d, i) => (
            <li key={i}>{describe(d)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describe(detail: unknown): string {
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    switch (d.code) {
      case "unmapped":
        return `Account ${String(d.account)} has a balance but doesn't map to any report line.`;
      case "overlap":
        return `Mapping ranges ${String(d.first_from)}–${String(d.first_to)} and ${String(d.second_from)}–${String(d.second_to)} overlap.`;
      case "unknown_line":
        return `Mapping range ${String(d.from)}–${String(d.to)} points at a line the template doesn't have (${String(d.line)}).`;
      case "reversed_range":
        return `Mapping range ${String(d.from)}–${String(d.to)} runs backwards.`;
    }
    const code = typeof d.code === "string" ? d.code.replace(/_/g, " ") : "problem";
    const account = typeof d.account === "string" ? ` ${d.account}` : "";
    return `${code}${account}`;
  }
  return String(detail);
}
