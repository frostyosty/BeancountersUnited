import registryJson from "../icons/registry.json";

/** One icon a slot can show: an emoji, or an image path below the site root ("icons/x.png"). */
export interface IconEntry {
  type: "emoji" | "image";
  value: string;
  variants?: { type: "emoji" | "image"; value: string }[];
}

type Registry = Record<string, Record<string, IconEntry>>;

// Written by tools/icon-studio (make icons); never edit by hand.
const registry = registryJson as Registry;

/** The registry name for an emoji: its code points without U+FE0F, as the studio writes them. */
export function emojiKey(emoji: string): string {
  return Array.from(emoji)
    .filter((c) => c !== "\uFE0F")
    .map((c) => c.codePointAt(0)!.toString(16))
    .join("_");
}

export function slotEntry(slot: string): IconEntry | undefined {
  const [group, name] = slot.split(".");
  return group && name ? registry[group]?.[name] : undefined;
}

function Glyph({ entry, className }: { entry: IconEntry; className?: string }) {
  if (entry.type === "image") {
    return (
      <img
        className={className}
        src={`/${entry.value}`}
        alt=""
        aria-hidden="true"
        width="1em"
        height="1em"
        style={{ verticalAlign: "-0.15em" }}
      />
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {entry.value}
    </span>
  );
}

/** A decorative icon for a registry slot (group.name). Always pair it with a text label. */
export function Icon({ name, fallback = "", className }: { name: string; fallback?: string; className?: string }) {
  const entry = slotEntry(name) ?? (fallback ? { type: "emoji" as const, value: fallback } : undefined);
  return entry ? <Glyph entry={entry} className={className} /> : null;
}

/** An emoji that the icon studio can swap for an image: <Emoji>💬</Emoji>. */
export function Emoji({ children, className }: { children: string; className?: string }) {
  const entry = registry.emoji?.[emojiKey(children)];
  return <Glyph entry={entry ?? { type: "emoji", value: children }} className={className} />;
}
