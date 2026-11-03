/** What we show for a bank line the bank sent with no text. */
export const NO_DESCRIPTION = "(no description)";

/**
 * A bank line's description for the screen. A line with no text is stored with an empty
 * description (docs/domain.md, "Bank statement formats"), so nothing made up reaches duplicate
 * keys or rules; only the screen shows a placeholder.
 */
export function lineDescription(description: string): string {
  return description.trim() === "" ? NO_DESCRIPTION : description;
}
