/**
 * The reader's color theme. `system` follows the operating system's appearance; `light` and
 * `dark` override it. The choice lives in a cookie on this device, so every dashboard page and the
 * desktop app's own pages read the same value, and a server can read it from the request.
 *
 * The document root carries `data-theme="light"` or `data-theme="dark"` for an override and no
 * attribute for `system`. The styles derive `color-scheme`, every color token and Tailwind's
 * `dark:` variant from that attribute, falling back to `prefers-color-scheme` without it.
 */
import { Schema } from "effect";

export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = typeof Theme.Type;
export const isTheme = Schema.is(Theme);

/** The themes stored as an override; `system` is stored as their absence. */
const overrides = Theme.literals.filter((theme) => theme !== "system");

/** Holds an override; `system` is the cookie's absence. */
export const themeCookie = "executor-theme";

/** The theme a stored value names, from the cookie or the root's `data-theme`; else `system`. */
export const parseTheme = (value: string | undefined): Theme =>
  value !== undefined && isTheme(value) ? value : "system";

/**
 * Applies a saved override before the first paint, so a page never flashes the system theme
 * first. The dashboard document runs it inline in its head, after the `color-scheme` meta tag.
 * It runs before any bundle loads, so it is self-contained; `useTheme` applies a change the same
 * way.
 */
export const applySavedThemeScript = `(() => {
  const saved = document.cookie.split("; ").find((part) => part.startsWith("${themeCookie}="));
  const theme = saved && saved.slice(${themeCookie.length + 1});
  if (!${JSON.stringify(overrides)}.includes(theme)) return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = theme;
})();`;
