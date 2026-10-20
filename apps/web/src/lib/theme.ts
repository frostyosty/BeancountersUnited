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
