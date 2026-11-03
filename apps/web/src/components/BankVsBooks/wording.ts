import type { ReconcileAccountKind } from "@acct/types/ReconcileAccountKind";
import { formatMoney } from "../../lib/money";

/**
 * A balance in the account's own words. Balances are signed from the account's point of view, so
 * a card's balance owed is negative: "you owe $1,087.55". A bank account below zero is overdrawn.
 */
export function balanceWords(cents: number, kind: ReconcileAccountKind): string {
  if (kind === "credit_card") {
    if (cents < 0) return `you owe $${formatMoney(-cents)}`;
    if (cents > 0) return `in credit $${formatMoney(cents)}`;
    return "nothing owed";
  }
  return cents < 0 ? `overdrawn $${formatMoney(-cents)}` : `$${formatMoney(cents)}`;
}

/** "Agrees", or "Out by $412.50" (the size of the difference, whichever way it goes). */
export function verdictWords(difference: number): string {
  return difference === 0 ? "Agrees" : `Out by $${formatMoney(Math.abs(difference))}`;
}
