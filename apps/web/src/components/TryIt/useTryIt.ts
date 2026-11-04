import type { ExampleStatement } from "@acct/types/ExampleStatement";
import { useCallback, useMemo, useState } from "react";

/** What the Upload step shows once a file or example is in. */
export interface UploadSummary {
  fileName: string;
  /** Null until the parser has read the file. */
  bank: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lineCount: number | null;
}

/** A Save tax card as the home page shows it. Agent 5 fills these from the real queue. */
export interface TryItCard {
  id: string;
  title: string;
}

/** idle → uploading → working out the tax → ready (tax, top cards) | error. */
export type TryItState =
  | { phase: "idle" }
  | { phase: "uploading"; upload: UploadSummary }
  | { phase: "working"; upload: UploadSummary }
  | { phase: "ready"; upload: UploadSummary; tax: number; cards: TryItCard[] }
  | { phase: "error"; message: string; upload?: UploadSummary };

export interface TryIt {
  state: TryItState;
  /** Load example 1 to 3, as a drop of that file would. */
  useExample: (n: number) => void;
  /** Load a file the visitor dropped or chose. */
  useFile: (file: File) => void;
  reset: () => void;
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

/**
 * STUB for this wave (Agent 4): it only moves into `working` so the layout can be seen and tested.
 * Agent 5 replaces the body with the real guest flow; the returned shape is the contract, and
 * the components take a `TryIt` as a prop, so they don't change.
 */
export function useTryIt(examples: ExampleStatement[] = []): TryIt {
  const [state, setState] = useState<TryItState>({ phase: "idle" });

  const useExample = useCallback(
    (n: number) => {
      const e = examples.find((x) => x.number === n);
      if (!e) {
        setState({ phase: "error", message: "We couldn't load that example. Please try again." });
        return;
      }
      setState({ phase: "working", upload: summaryOfExample(e) });
    },
    [examples],
  );

  const useFile = useCallback((file: File) => {
    setState({
      phase: "working",
      upload: { fileName: file.name, bank: null, periodStart: null, periodEnd: null, lineCount: null },
    });
  }, []);

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return useMemo(() => ({ state, useExample, useFile, reset }), [state, useExample, useFile, reset]);
}
