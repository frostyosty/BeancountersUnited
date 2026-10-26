import { useState } from "react";
import { Icon } from "../../lib/icons";
import { type ColourScheme, saveScheme, storedScheme } from "../../lib/theme";
import { cx } from "../cx";
import styles from "./ThemeToggle.module.css";

const next: Record<ColourScheme, ColourScheme> = { system: "light", light: "dark", dark: "system" };
const label: Record<ColourScheme, string> = { system: "Auto", light: "Light", dark: "Dark" };
const icon: Record<ColourScheme, { slot: string; emoji: string }> = {
  system: { slot: "ui.theme_system", emoji: "🖥️" },
  light: { slot: "ui.theme_light", emoji: "☀️" },
  dark: { slot: "ui.theme_dark", emoji: "🌙" },
};

/** Cycles Auto → Light → Dark. Remembered in this browser only. */
export function ThemeToggle({ className }: { className?: string }) {
  const [scheme, setScheme] = useState<ColourScheme>(storedScheme);
  return (
    <button
      type="button"
      className={cx("ghost", "sm", styles.toggle, className)}
      title={`Colours: ${label[scheme]}. Click for ${label[next[scheme]]}.`}
      onClick={() => {
        const n = next[scheme];
        saveScheme(n);
        setScheme(n);
      }}
    >
      <Icon name={icon[scheme].slot} fallback={icon[scheme].emoji} /> {label[scheme]}
    </button>
  );
}
