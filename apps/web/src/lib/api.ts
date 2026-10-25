import type { Accepted } from "@acct/types/Accepted";
import type { AiSuggestRun } from "@acct/types/AiSuggestRun";
import type { ApiError } from "@acct/types/ApiError";
import type { Command } from "@acct/types/Command";
import type { Health } from "@acct/types/Health";
import type { LoginRequest } from "@acct/types/LoginRequest";
import type { MappingCheck } from "@acct/types/MappingCheck";
import type { MappingCheckRequest } from "@acct/types/MappingCheckRequest";
import type { Me } from "@acct/types/Me";
import type { PresentUser } from "@acct/types/PresentUser";
import type { SignedUp } from "@acct/types/SignedUp";
import type { SignUpRequest } from "@acct/types/SignUpRequest";
import type { TbImportPreview } from "@acct/types/TbImportPreview";
import type { Via } from "@acct/types/Via";
import { newId } from "./id";

/** A non-2xx response, carrying the server's structured error when it sent one. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiError | null, fallback: string) {
    super(body?.message ?? fallback);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = body?.code ?? "http_error";
    this.details = body?.details ?? null;
  }
}

async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as ApiError | null;
  throw new ApiRequestError(res.status, body, `${what} failed: ${res.status}`);
}

/** `GET`s a query endpoint and returns its JSON. */
export async function getJson<T>(path: string, fetchFn: typeof fetch = fetch): Promise<T> {
  const res = await fetchFn(path);
  if (!res.ok) {
    return fail(res, `GET ${path}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return fail(res, `POST ${path}`);
  }
  return (await res.json()) as T;
}

export function fetchHealth(fetchFn: typeof fetch = fetch): Promise<Health> {
  return getJson<Health>("/api/health", fetchFn);
}

/** The logged-in user, or `null` if there's no session. */
export async function fetchMe(fetchFn: typeof fetch = fetch): Promise<Me | null> {
  try {
    return await getJson<Me>("/api/me", fetchFn);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

/** Logs in; rejects with the server's message (for example, wrong username or password). */
export function login(req: LoginRequest, fetchFn: typeof fetch = fetch): Promise<Me> {
  return postJson<Me>("/api/login", req, fetchFn);
}

/** Signs a business owner up (M12): their account and business in one go, then signs them in. */
export function signUp(req: SignUpRequest, fetchFn: typeof fetch = fetch): Promise<SignedUp> {
  return postJson<SignedUp>("/api/signup", req, fetchFn);
}

export async function logout(fetchFn: typeof fetch = fetch): Promise<void> {
  await fetchFn("/api/logout", { method: "POST" });
}

/**
 * Submits a command. Pass the same `id` to retry safely: the server returns the original result.
 * Rejects with an `ApiRequestError` whose `code` and `details` say what was wrong.
 */
export function submitCommand(
  command: Command & { via?: Via },
  id: string = newId(),
  fetchFn: typeof fetch = fetch,
): Promise<Accepted> {
  return postJson<Accepted>("/api/commands", { id, ...command }, fetchFn);
}

/** Asks the AI service for suggestions for a business's unsorted lines (ADR 009). They come back as
 * pre-fills on the Save tax cards; nothing is applied until the owner accepts one. */
export function requestAiSuggestions(clientId: string, fetchFn: typeof fetch = fetch): Promise<AiSuggestRun> {
  return postJson<AiSuggestRun>(`/api/businesses/${clientId}/ai-suggestions`, {}, fetchFn);
}

/** Checks a draft mapping against its template and the master chart without saving it. */
export function checkMapping(req: MappingCheckRequest, fetchFn: typeof fetch = fetch): Promise<MappingCheck> {
  return postJson<MappingCheck>("/api/mappings/check", req, fetchFn);
}

/** Checks a TB CSV against a year without changing anything. */
export async function previewTbImport(yearId: string, csv: string, fetchFn: typeof fetch = fetch): Promise<TbImportPreview> {
  const path = `/api/years/${yearId}/tb-import/preview`;
  const res = await fetchFn(path, { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
  if (!res.ok) {
    return fail(res, `POST ${path}`);
  }
  return (await res.json()) as TbImportPreview;
}

/** Tells the server this browser is here, on `businessId` if any, and returns who else is (M13). */
export function sendPresence(businessId: string | null, fetchFn: typeof fetch = fetch): Promise<PresentUser[]> {
  return postJson<PresentUser[]>("/api/presence", businessId ? { business_id: businessId } : {}, fetchFn);
}
