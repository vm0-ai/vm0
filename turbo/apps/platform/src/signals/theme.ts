import { command, computed, state } from "ccstate";

/**
 * Internal state for theme (light or dark).
 */
const internalTheme$ = state<"light" | "dark">("light");

/**
 * Current theme value.
 */
export const theme$ = computed((get) => get(internalTheme$));

/**
 * Toggle between light and dark theme.
 */
export const toggleTheme$ = command(({ get, set }) => {
  const currentTheme = get(internalTheme$);
  const newTheme = currentTheme === "light" ? "dark" : "light";
  set(internalTheme$, newTheme);
  
  // Update the data-theme attribute on the root element
  document.documentElement.setAttribute("data-theme", newTheme);
  
  // Store preference in localStorage
  localStorage.setItem("theme", newTheme);
});

/**
 * Initialize theme from localStorage or system preference.
 */
export const initTheme$ = command(({ set }) => {
  // Check localStorage first
  const stored = localStorage.getItem("theme") as "light" | "dark" | null;
  
  if (stored) {
    set(internalTheme$, stored);
    document.documentElement.setAttribute("data-theme", stored);
    return;
  }
  
  // Fall back to system preference
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = prefersDark ? "dark" : "light";
  set(internalTheme$, theme);
  document.documentElement.setAttribute("data-theme", theme);
});
