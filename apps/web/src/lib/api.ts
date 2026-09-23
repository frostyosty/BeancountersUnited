import type { Health } from "@acct/types/Health";

export async function fetchHealth(fetchFn: typeof fetch = fetch): Promise<Health> {
  const res = await fetchFn("/api/health");
  if (!res.ok) {
    throw new Error(`GET /api/health failed: ${res.status}`);
  }
  return (await res.json()) as Health;
}
