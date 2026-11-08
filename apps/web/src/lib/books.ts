/** The accountant view's screens, in the order of its tabs (ADR 015, 1.2). */
export type BooksView = "statements" | "tb" | "journals" | "gl" | "assets" | "changes";

/**
 * Where a view of a business's books lives: `/businesses/{id}/books/{view}`. The switch on the
 * owner's screen and the home page's tiles build their links here.
 */
export function booksPath(businessId: string, view: BooksView = "statements"): string {
  return `/businesses/${businessId}/books/${view}`;
}

const openedKey = (guestUserId: string) => `acct.guest.${guestUserId}.books`;

/**
 * Notes that this guest opened the accountant view, so Save your work asks "Who are you?" (ADR
 * 015, 6). Keyed by the guest's user id, so a later guest in the same browser isn't asked because of
 * an earlier one. Browser storage only: it's a nudge, and the page works without it.
 */
export function rememberAccountantViewOpened(guestUserId: string): void {
  try {
    window.localStorage.setItem(openedKey(guestUserId), "1");
  } catch {
    // Blocked or full: they just aren't asked, and get the owner's path.
  }
}

/** Whether this guest opened the accountant view in this browser. False when storage is blocked. */
export function hasOpenedAccountantView(guestUserId: string): boolean {
  try {
    return window.localStorage.getItem(openedKey(guestUserId)) === "1";
  } catch {
    return false;
  }
}
