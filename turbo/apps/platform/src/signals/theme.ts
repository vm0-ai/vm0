import { command, computed, state } from "ccstate";
import { localStorageSignals } from "./external/local-storage.ts";

export type ThemePreference = "light" | "dark" | "system";

export const COLOR_THEMES = [
  "golden-hour",
  "citrus-spark",
  "berry-blush",
  "cotton-sky",
  "blue-horizon",
  "daydream",
  "deep-lagoon",
  "limelight",
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number];

export const DEFAULT_COLOR_THEME: ColorTheme = "blue-horizon";

function isThemePreference(v: string | null): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function isColorTheme(value: string | null): value is ColorTheme {
  return COLOR_THEMES.some((theme) => {
    return theme === value;
  });
}

const internalPreference$ = state<ThemePreference>("system");
const internalResolved$ = state<"light" | "dark">("light");
const internalColorTheme$ = state<ColorTheme>(DEFAULT_COLOR_THEME);

const { get$: themeStorageGet$, set$: themeStorageSet$ } =
  localStorageSignals("theme");
const { get$: colorThemeStorageGet$, set$: colorThemeStorageSet$ } =
  localStorageSignals("colorTheme");

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

/**
 * User's palette-derived workspace color theme.
 */
export const colorTheme$ = computed((get) => {
  return get(internalColorTheme$);
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
 * Set and persist the palette-derived workspace color theme.
 */
export const setColorTheme$ = command(({ set }, colorTheme: ColorTheme) => {
  set(internalColorTheme$, colorTheme);
  set(colorThemeStorageSet$, colorTheme);
});

/**
 * Keep palette theme attributes on the document while a themed app shell is
 * mounted. Document scope lets portaled dialogs and popovers inherit the same
 * semantic tokens as the app shell.
 */
export function applyColorThemeDocumentAttributes(
  enabled: boolean,
  colorTheme: ColorTheme,
) {
  const root = document.documentElement;

  if (enabled) {
    root.dataset.gradientColorThemes = "";
    root.dataset.colorTheme = colorTheme;
  } else {
    delete root.dataset.gradientColorThemes;
    delete root.dataset.colorTheme;
  }
}

/**
 * Initialize theme from localStorage or system preference.
 */
export const initTheme$ = command(({ get, set }) => {
  const rawStored = get(themeStorageGet$);
  const preference = isThemePreference(rawStored) ? rawStored : "system";
  const rawStoredColorTheme = get(colorThemeStorageGet$);
  const colorTheme = isColorTheme(rawStoredColorTheme)
    ? rawStoredColorTheme
    : DEFAULT_COLOR_THEME;
  set(internalPreference$, preference);
  set(internalColorTheme$, colorTheme);
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
