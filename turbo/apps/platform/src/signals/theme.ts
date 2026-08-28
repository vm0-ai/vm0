import { command, computed, state } from "ccstate";
import {
  COLOR_THEMES,
  type ColorTheme,
  type ThemePreference,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { localStorageSignals } from "./external/local-storage.ts";
import { clerk$ } from "./auth.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./okou-page/settings/user-preferences.ts";

export { COLOR_THEMES };
export type { ColorTheme, ThemePreference };

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

type CurrentAppearancePreferences = UserPreferencesResponse & {
  readonly theme: ThemePreference | null;
  readonly colorTheme: ColorTheme | null;
};

/**
 * New web/app -> old API compatibility for the GA theme preference. Keep the
 * theme local while an API from before #30051 is serving or retained for
 * rollback. Remove this guard and its page test after that gate closes in
 * #30076. The non-GA color theme does not use an independent update fallback.
 */
function hasServerAppearancePreferences(
  preferences: UserPreferencesResponse,
): preferences is CurrentAppearancePreferences {
  const hasTheme = preferences.theme !== undefined;
  const hasColorTheme = preferences.colorTheme !== undefined;
  if (hasTheme !== hasColorTheme) {
    throw new Error("Appearance preference response is incomplete");
  }
  return hasTheme;
}

/**
 * Apply a theme choice immediately, then persist it when the current API
 * advertises server-backed theme preferences.
 */
export const updateThemePreference$ = command(
  async ({ get, set }, preference: ThemePreference, signal: AbortSignal) => {
    set(setTheme$, preference);
    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    if (!hasServerAppearancePreferences(preferences)) {
      return;
    }
    await set(updateUserPreference$, { theme: preference }, signal);
  },
);

/**
 * Apply a color theme immediately, then persist it when supported by the API.
 */
export const updateColorThemePreference$ = command(
  async ({ set }, colorTheme: ColorTheme, signal: AbortSignal) => {
    set(setColorTheme$, colorTheme);
    await set(updateUserPreference$, { colorTheme }, signal);
  },
);

/**
 * Reconcile the fast local bootstrap cache with the workspace preference.
 * Null server values migrate the current device choice; missing keys mean an
 * older API is still serving this frontend, so local-only behavior continues.
 */
export const syncThemePreferences$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    if (!hasServerAppearancePreferences(preferences)) {
      return;
    }

    const theme = preferences.theme ?? get(themePreference$);
    const colorTheme = preferences.colorTheme ?? get(colorTheme$);

    set(setTheme$, theme);
    set(setColorTheme$, colorTheme);

    if (preferences.theme === null || preferences.colorTheme === null) {
      await set(
        updateUserPreference$,
        {
          ...(preferences.theme === null && { theme }),
          ...(preferences.colorTheme === null && { colorTheme }),
        },
        signal,
      );
    }
  },
);

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
