import type { BusinessView } from "@acct/types/BusinessView";
import type { ExampleStatement } from "@acct/types/ExampleStatement";
import type { GstSource } from "@acct/types/GstSource";
import type { GuestSource } from "@acct/types/GuestSource";
import type { Me } from "@acct/types/Me";
import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import type { SaveTaxQueue } from "@acct/types/SaveTaxQueue";
import type { TaxNotice } from "@acct/types/TaxNotice";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getJson, startGuest } from "../../lib/api";
import { formatDate } from "../../lib/dates";
import { fileToBase64 } from "../../lib/files";
import { newId } from "../../lib/id";
import { keys } from "../../lib/queries";
import { saveTaxKey } from "../../pages/SaveTaxPage";
import { useMediaQuery } from "./useExamples";

/** What the Upload step shows once a file or example is in. */
export interface UploadSummary {
  fileName: string;
  /** Null until the parser has read the file. */
  bank: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lineCount: number | null;
}

/** How many Save tax cards the home page shows; "See all" opens the rest. */
export const TOP_CARDS = 3;

/** The loader shows for at least this long from the drop, even when the server is faster. */
export const MIN_WORK_MS = 2000;
/** With reduced motion there's no animation, so the wait is just long enough to read the steps. */
export const MIN_WORK_MS_REDUCED = 400;

/** Why we think the business is, or isn't, GST registered: the server's `gst_source`. */
export interface GstNote {
  registered: boolean;
  source: GstSource | "none";
  /** "two-monthly", "monthly" or "six-monthly". */
  frequency: string | null;
  /** What proved it, when detected: "a GST payment to IRD on 22 Oct 2025". */
  evidence: string | null;
}

/** idle → uploading → working out the tax → ready (tax, top cards) | error. */
export type TryItState =
  | { phase: "idle" }
  | { phase: "uploading"; upload: UploadSummary }
  | { phase: "working"; upload: UploadSummary }
  | {
      phase: "ready";
      upload: UploadSummary;
      businessId: string;
      /** The example's number, or null for a visitor's own file. */
      example: number | null;
      /** "Tax to pay if submitted" now, from the server. */
      tax: number;
      /** What it was with nothing answered, and what the answers have saved: both the server's. */
      conservative: number;
      savedSoFar: number;
      notices: TaxNotice[];
      /** The top cards of the real Save tax queue, and how many more it holds. */
      cards: SaveTaxCard[];
      moreCards: number;
      gst: GstNote;
      /** The figure is being worked out again after an answer. */
      refreshing: boolean;
      business: BusinessView;
    }
  | { phase: "error"; message: string; upload?: UploadSummary };

export interface TryIt {
  state: TryItState;
  /** Load example 1 to 3, as a drop of that file would. */
  useExample: (n: number) => void;
  /** Load a file the visitor dropped or chose. */
  useFile: (file: File) => void;
  /** Try again after an error. */
  retry: () => void;
  reset: () => void;
  /**
   * Makes the signed-out app know the guest, so the owner screens open. Call it from the click on
   * a link into `/businesses/{id}`.
   */
  enterApp: () => void;
}

export function summaryOfExample(e: ExampleStatement): UploadSummary {
  return {
    fileName: e.file_name,
    bank: e.bank,
    periodStart: e.period_start,
    periodEnd: e.period_end,
    lineCount: e.lines.length,
  };
}

const NETWORK_MESSAGE = "We couldn't reach the server. Check your connection and try again.";

function messageOf(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : NETWORK_MESSAGE;
}

const FREQUENCY_WORDS: Record<string, string> = {
  monthly: "monthly",
  two_monthly_odd: "two-monthly",
  two_monthly_even: "two-monthly",
  six_monthly: "six-monthly",
};

/** Works out the GST note from what the server says about the business. */
export function gstNoteOf(business: BusinessView): GstNote {
  const registered = business.gst_registered_from !== null;
  const line = business.gst_evidence;
  return {
    registered,
    source: registered ? business.gst_source : "none",
    frequency: registered && business.gst_frequency ? (FREQUENCY_WORDS[business.gst_frequency] ?? null) : null,
    evidence: line ? `${line.amount > 0 ? "a GST refund from IRD" : "a GST payment to IRD"} on ${formatDate(line.date)}` : null,
  };
}

/** The Upload step's summary, with what the server read from a file once it has. */
function summaryOfUpload(base: UploadSummary, business: BusinessView | undefined): UploadSummary {
  if (!business || base.lineCount !== null) return base;
  for (const account of business.bank_accounts) {
    // A trial picked up again has no file name of its own: its latest statement stands for it.
    const statement = account.statements.find((s) => s.file_name === base.fileName) ?? (base.fileName === "" ? account.statements.at(-1) : undefined);
    if (statement) {
      return {
        fileName: statement.file_name,
        bank: account.name,
        periodStart: statement.start,
        periodEnd: statement.end,
        lineCount: statement.lines_in_file,
      };
    }
  }
  return base;
}

/** `prefers-reduced-motion: reduce`. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)", false);
}

/** A guest coming back to the home page carries on with their trial: their own file first, else
 * their example. No loader: the work was done the first time. */
function resumed(me: Me | null | undefined): Session | null {
  const guest = me?.guest;
  if (!me || !guest) return null;
  const businessId = guest.business_id ?? guest.example?.business_id;
  if (!businessId) return null;
  return {
    businessId,
    example: guest.business_id ? null : (guest.example?.number ?? null),
    me,
    upload: { fileName: "", bank: null, periodStart: null, periodEnd: null, lineCount: null },
    droppedAt: 0,
  };
}

interface Session {
  businessId: string;
  example: number | null;
  me: Me;
  upload: UploadSummary;
  droppedAt: number;
}

/** What `retry` runs again. `id` is kept after a failure that got no reply, so a reply that was only
 * lost returns the original result instead of starting a second guest. */
interface Attempt {
  source: () => Promise<GuestSource>;
  upload: UploadSummary;
  example: number | null;
  id: string | null;
}

/**
 * The home page's try-it flow (M20, ADR 014). A drop, or "Use this example", starts a guest (or adds
 * to the visitor's own) through `POST /api/guest`, the server imports the file, and then the tax and
 * the Save tax queue are read for that business. The figure is always the server's. The loader
 * shows for `minWorkMs` from the drop even when the server is faster.
 */
export function useTryIt(examples: ExampleStatement[] = [], options: { minWorkMs?: number } = {}): TryIt {
  const qc = useQueryClient();
  const reduced = useReducedMotion();
  const minWorkMs = options.minWorkMs ?? (reduced ? MIN_WORK_MS_REDUCED : MIN_WORK_MS);

  const [pending, setPending] = useState<UploadSummary | null>(null);
  const [failure, setFailure] = useState<{ message: string; upload?: UploadSummary } | null>(null);
  const [session, setSession] = useState<Session | null>(() => resumed(qc.getQueryData<Me | null>(["me"])));
  const [waited, setWaited] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const examplesRef = useRef(examples);
  examplesRef.current = examples;
  // A newer drop makes an older one's reply irrelevant.
  const generation = useRef(0);

  const run = useCallback(
    async (next: Attempt) => {
      const mine = ++generation.current;
      attempt.current = next;
      const droppedAt = Date.now();
      setFailure(null);
      setWaited(false);
      setPending(next.upload);
      const id = next.id ?? newId();
      try {
        const source = await next.source();
        const res = await startGuest({ id, source });
        if (mine !== generation.current) return;
        // Whatever an earlier drop on the same business left in the cache is stale now.
        await qc.invalidateQueries({ queryKey: keys.business(res.business_id) });
        if (mine !== generation.current) return;
        attempt.current = null;
        setPending(null);
        setSession({ businessId: res.business_id, example: next.example, me: res.me, upload: next.upload, droppedAt });
      } catch (err) {
        if (mine !== generation.current) return;
        // Only a lost reply keeps the id: a refusal never made a guest, so it can't be replayed.
        attempt.current = { ...next, id: err instanceof ApiRequestError ? null : id };
        setPending(null);
        setSession(null);
        setFailure({ message: messageOf(err), upload: next.upload });
      }
    },
    [qc],
  );

  const useExample = useCallback(
    (n: number) => {
      const e = examplesRef.current.find((x) => x.number === n);
      void run({
        source: async () => ({ example: n }),
        upload: e
          ? summaryOfExample(e)
          : { fileName: `Example ${n}`, bank: null, periodStart: null, periodEnd: null, lineCount: null },
        example: n,
        id: null,
      });
    },
    [run],
  );

  const useFile = useCallback(
    (file: File) => {
      void run({
        source: async () => ({ file: { file_name: file.name, content_base64: await fileToBase64(file) } }),
        upload: { fileName: file.name, bank: null, periodStart: null, periodEnd: null, lineCount: null },
        example: null,
        id: null,
      });
    },
    [run],
  );

  const retry = useCallback(() => {
    if (attempt.current) void run(attempt.current);
    // The drop went in but reading the tax failed: read it again.
    else if (session) void qc.invalidateQueries({ queryKey: keys.business(session.businessId) });
  }, [run, qc, session]);

  const reset = useCallback(() => {
    generation.current++;
    attempt.current = null;
    setPending(null);
    setFailure(null);
    setSession(null);
    setWaited(false);
  }, []);

  const enterApp = useCallback(() => {
    if (session) qc.setQueryData<Me | null>(["me"], session.me);
  }, [qc, session]);

  // The minimum loader time, counted from the drop.
  useEffect(() => {
    if (!session) return;
    const left = Math.max(0, minWorkMs - (Date.now() - session.droppedAt));
    if (left === 0) {
      setWaited(true);
      return;
    }
    const timer = setTimeout(() => setWaited(true), left);
    return () => clearTimeout(timer);
  }, [session, minWorkMs]);

  const businessId = session?.businessId ?? "";
  const on = session !== null;
  const taxQ = useQuery({
    queryKey: keys.tax(businessId),
    queryFn: () => getJson<TaxPosition>(`/api/businesses/${businessId}/tax`),
    enabled: on,
  });
  const queueQ = useQuery({
    queryKey: saveTaxKey(businessId),
    queryFn: () => getJson<SaveTaxQueue>(`/api/businesses/${businessId}/save-tax`),
    enabled: on,
  });
  const businessQ = useQuery({
    queryKey: keys.business(businessId),
    queryFn: () => getJson<BusinessView>(`/api/businesses/${businessId}`),
    enabled: on,
  });

  const state = useMemo<TryItState>(() => {
    if (failure) return { phase: "error", ...failure };
    if (!session) return pending ? { phase: "uploading", upload: pending } : { phase: "idle" };
    const upload = summaryOfUpload(session.upload, businessQ.data);
    const error = taxQ.error ?? queueQ.error ?? businessQ.error;
    if (error) return { phase: "error", message: messageOf(error), upload };
    if (!waited || !taxQ.data || !queueQ.data || !businessQ.data) return { phase: "working", upload };
    return {
      phase: "ready",
      upload,
      businessId: session.businessId,
      example: session.example,
      tax: taxQ.data.total,
      conservative: queueQ.data.conservative_total,
      savedSoFar: queueQ.data.saved_so_far,
      notices: taxQ.data.notices,
      cards: queueQ.data.cards.slice(0, TOP_CARDS),
      moreCards: Math.max(0, queueQ.data.cards.length - TOP_CARDS),
      gst: gstNoteOf(businessQ.data),
      refreshing: taxQ.isFetching || queueQ.isFetching,
      business: businessQ.data,
    };
  }, [failure, session, pending, waited, taxQ.data, taxQ.error, taxQ.isFetching, queueQ.data, queueQ.error, queueQ.isFetching, businessQ.data, businessQ.error]);

  return useMemo(
    () => ({ state, useExample, useFile, retry, reset, enterApp }),
    [state, useExample, useFile, retry, reset, enterApp],
  );
}
