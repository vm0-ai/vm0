import { command, computed, state } from "ccstate";
import { localStorageSignals } from "./external/local-storage.ts";

export type ThemePreference = "light" | "dark" | "system";

function isThemePreference(v: string | null): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

const internalPreference$ = state<ThemePreference>("system");
const internalResolved$ = state<"light" | "dark">("light");

const { get$: themeStorageGet$, set$: themeStorageSet$ } =
  localStorageSignals("theme");

/**
 * Current resolved theme value (always "light" or "dark").
 */
export const theme$ = computed((get) => {
  return get(internalResolved$);
});

/**
 * User's theme preference ("light", "dark", or "system").
 */
export const themePreference$ = computed((get) => {
  return get(internalPreference$);
});

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return preference;
}

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

/**
 * Set theme preference and apply it.
 */
export const setTheme$ = command(({ set }, preference: ThemePreference) => {
  set(internalPreference$, preference);
  const resolved = resolveTheme(preference);
  set(internalResolved$, resolved);
  applyTheme(resolved);
  set(themeStorageSet$, preference);
});

/**
 * Initialize theme from localStorage or system preference.
 */
export const initTheme$ = command(({ get, set }) => {
  const rawStored = get(themeStorageGet$);
  const preference = isThemePreference(rawStored) ? rawStored : "system";
  set(internalPreference$, preference);
  const resolved = resolveTheme(preference);
  set(internalResolved$, resolved);
  applyTheme(resolved);

  // Listen for system theme changes when preference is "system"
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const currentPref = get(themeStorageGet$);
      if (!isThemePreference(currentPref) || currentPref === "system") {
        const newResolved = window.matchMedia("(prefers-color-scheme: dark)")
          .matches
          ? "dark"
          : "light";
        set(internalResolved$, newResolved);
        applyTheme(newResolved);
      }
    });
});
