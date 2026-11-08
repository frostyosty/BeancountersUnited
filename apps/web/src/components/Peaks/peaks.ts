/**
 * The peaks: the few moments an account is asked for (M21, ADR 015, 3). Nothing here fires on arrival
 * or on the way out. The browser only compares the server's figure with this constant.
 */

/** The first-saving line shows once `saved_so_far` reaches $100.00 (ADR 015, 3.1). */
export const SAVING_THRESHOLD_CENTS = 10_000;

const savingKey = (businessId: string) => `acct.peak.saving.${businessId}`;

/**
 * Whether the first-saving line was already shown for this trial. Browser storage only, since it's a
 * nudge: when storage is blocked or cleared the worst case is that the line shows once more.
 */
export function hasSeenSavingPeak(businessId: string): boolean {
  try {
    return window.localStorage.getItem(savingKey(businessId)) === "1";
  } catch {
    return false;
  }
}

/** Records that the first-saving line was shown, so it doesn't come back on a later visit. */
export function noteSavingPeak(businessId: string): void {
  try {
    window.localStorage.setItem(savingKey(businessId), "1");
  } catch {
    // Blocked or full: the line may show once more. The page works without it.
  }
}
