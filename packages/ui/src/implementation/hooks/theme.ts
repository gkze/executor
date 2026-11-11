/** The reader's color theme; see `contracts/theme.ts`. */
import { useCallback, useSyncExternalStore } from "react";
import { parseTheme, themeCookie, type Theme } from "../../contracts/theme.ts";

/** The root's `data-theme` is the current choice; the saved script set it before first paint. */
const readTheme = (): Theme => parseTheme(document.documentElement.dataset.theme);

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};

/**
 * The current theme and a way to change it. Changing it saves the cookie for later documents and
 * updates this one at once. Server renders and hydration report `system`, then the saved choice.
 */
export function useTheme(): readonly [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as const);
  const setTheme = useCallback((next: Theme) => {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      next === "system"
        ? `${themeCookie}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
        : `${themeCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    // Elements with color transitions would fade while the rest of the page switches at once.
    const instant = document.createElement("style");
    instant.textContent = "*, *::before, *::after { transition: none !important; }";
    document.head.append(instant);
    const root = document.documentElement;
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    document
      .querySelector('meta[name="color-scheme"]')
      ?.setAttribute("content", next === "system" ? "light dark" : next);
    // Style the page in the new theme before transitions return.
    getComputedStyle(root).getPropertyValue("color");
    requestAnimationFrame(() => instant.remove());
  }, []);
  return [theme, setTheme];
}

/**
 * A media query that matches when the page shows its dark theme, for markup the browser picks
 * from a query, such as `<picture>` sources.
 */
export const darkThemeMedia = (theme: Theme) =>
  theme === "dark" ? "all" : theme === "light" ? "not all" : "(prefers-color-scheme: dark)";
