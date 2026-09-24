import type { ApiError } from "@acct/types/ApiError";
import type { Health } from "@acct/types/Health";
import type { LoginRequest } from "@acct/types/LoginRequest";
import type { Me } from "@acct/types/Me";

export async function fetchHealth(fetchFn: typeof fetch = fetch): Promise<Health> {
  const res = await fetchFn("/api/health");
  if (!res.ok) {
    throw new Error(`GET /api/health failed: ${res.status}`);
  }
  return (await res.json()) as Health;
}

/** The logged-in user, or `null` if there's no session. */
export async function fetchMe(fetchFn: typeof fetch = fetch): Promise<Me | null> {
  const res = await fetchFn("/api/me");
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`GET /api/me failed: ${res.status}`);
  }
  return (await res.json()) as Me;
}

/** Logs in; rejects with the server's message (for example, wrong username or password). */
export async function login(req: LoginRequest, fetchFn: typeof fetch = fetch): Promise<Me> {
  const res = await fetchFn("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(err?.message ?? `POST /api/login failed: ${res.status}`);
  }
  return (await res.json()) as Me;
}

export async function logout(fetchFn: typeof fetch = fetch): Promise<void> {
  await fetchFn("/api/logout", { method: "POST" });
}
