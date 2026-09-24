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
    const code = typeof d.code === "string" ? d.code.replace(/_/g, " ") : "problem";
    const account = typeof d.account === "string" ? ` ${d.account}` : "";
    return `${code}${account}`;
  }
  return String(detail);
}
