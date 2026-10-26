/** Site theme and contact details, read from apps/web/.env (VITE_THEME_*, VITE_CONTACT_*). */
const env = import.meta.env;

export const contact = {
  email: env.VITE_CONTACT_EMAIL ?? "hello@example.co.nz",
  phone: env.VITE_CONTACT_PHONE ?? "0800 000 000",
  address: env.VITE_CONTACT_ADDRESS ?? "Level 1, 123 Sample Street, Wellington 6011",
};

const vars: Record<string, string | undefined> = {
  "--theme-color-1": env.VITE_THEME_COLOR_1,
  "--theme-color-2": env.VITE_THEME_COLOR_2,
  "--theme-accent": env.VITE_THEME_COLOR_ACCENT,
  "--theme-font": env.VITE_THEME_FONT,
  "--theme-icon-size": env.VITE_THEME_ICON_SIZE,
};

export function applyTheme(root: HTMLElement = document.documentElement) {
  for (const [name, value] of Object.entries(vars)) {
    if (value) root.style.setProperty(name, value);
  }
}

/** Light, dark, or whatever the system says. Pinned on <html data-theme>; tokens.css does the rest. */
export type ColourScheme = "system" | "light" | "dark";

const SCHEME_KEY = "acct.colour-scheme";

export function storedScheme(): ColourScheme {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyScheme(scheme: ColourScheme, root: HTMLElement = document.documentElement) {
  if (scheme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", scheme);
  }
}

/** Remembers the viewer's choice in this browser only; it's a convenience, not account data. */
export function saveScheme(scheme: ColourScheme) {
  applyScheme(scheme);
  try {
    if (scheme === "system") localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, scheme);
  } catch {
    // Storage blocked (private window): the choice lasts until the page reloads.
  }
}
