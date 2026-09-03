import { command, computed, state } from "ccstate";
import {
  COLOR_THEMES,
  type ColorTheme,
  type ThemePreference,
} from "@okouai/api-contracts/contracts/user-preferences";
import { localStorageSignals } from "./external/local-storage.ts";
import { clerk$ } from "./auth.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./okou-page/settings/user-preferences.ts";
import { isOkouHostname } from "../lib/platform-host.ts";
import {
  readOkouThemePreferenceFromDocument,
  writeOkouThemePreferenceToDocument,
} from "../lib/okou-theme-cookie.ts";

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
  if (isOkouHostname(location.hostname)) {
    /* eslint-disable ccstate/no-catch-abort -- synchronous storage access cannot carry an application AbortSignal. */
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be blocked; the cookie and in-memory theme remain valid fallbacks.
    try {
      set(themeStorageSet$, preference);
    } catch {
      // Storage can be blocked; the in-memory and document themes still apply.
    }
    /* eslint-enable ccstate/no-catch-abort */
    writeOkouThemePreferenceToDocument(preference);
  } else {
    set(themeStorageSet$, preference);
  }
});

/**
 * Set and persist the palette-derived workspace color theme.
 */
export const setColorTheme$ = command(({ set }, colorTheme: ColorTheme) => {
  set(internalColorTheme$, colorTheme);
  if (isOkouHostname(location.hostname)) {
    /* eslint-disable ccstate/no-catch-abort -- synchronous storage access cannot carry an application AbortSignal. */
    // eslint-disable-next-line no-restricted-syntax -- blocked localStorage must not prevent the authenticated theme preference from synchronizing.
    try {
      set(colorThemeStorageSet$, colorTheme);
    } catch {
      // Keep Okou usable when browser storage is unavailable.
    }
    /* eslint-enable ccstate/no-catch-abort */
  } else {
    set(colorThemeStorageSet$, colorTheme);
  }
});

/**
 * Apply a theme choice immediately, then persist it to the workspace.
 */
export const updateThemePreference$ = command(
  async ({ set }, preference: ThemePreference, signal: AbortSignal) => {
    set(setTheme$, preference);
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
 * Reconcile the fast local bootstrap cache with the authoritative workspace
 * preference. Null server values migrate the cookie or current device choice.
 */
export const syncThemePreferences$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      if (isOkouHostname(location.hostname)) {
        writeOkouThemePreferenceToDocument(get(themePreference$));
      }
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();

    const theme = preferences.theme ?? get(themePreference$);
    const colorTheme = preferences.colorTheme ?? get(colorTheme$);

    set(setTheme$, theme);
    set(setColorTheme$, colorTheme);

    const shouldUpdateTheme = preferences.theme === null;
    if (shouldUpdateTheme || preferences.colorTheme === null) {
      await set(
        updateUserPreference$,
        {
          ...(shouldUpdateTheme && { theme }),
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
 * Keep the Geist typeface attribute on the document while a themed app shell is
 * mounted. Document scope matches the color themes above: portaled dialogs,
 * popovers, and toasts read the same font tokens as the app shell.
 */
export function applyTypefaceDocumentAttribute(enabled: boolean) {
  const root = document.documentElement;

  if (enabled) {
    root.dataset.typeface = "geist";
  } else {
    delete root.dataset.typeface;
  }
}

/**
 * Keep the new shell attribute on the document while the app shell is mounted.
 * Document scope matches the two above: the shell's surfaces are read by the
 * sidebars and the workspace card, and portaled dialogs inherit the same
 * sidebar token.
 */
export function applyNewUiDocumentAttribute(enabled: boolean) {
  const root = document.documentElement;

  if (enabled) {
    root.dataset.newUi = "";
  } else {
    delete root.dataset.newUi;
  }
}

/**
 * Initialize theme from localStorage or system preference.
 */
export const initTheme$ = command(({ get, set }) => {
  const isOkou = isOkouHostname(location.hostname);
  const bootstrapOkouThemePreference = isOkou
    ? readOkouThemePreferenceFromDocument()
    : null;

  let rawStored: string | null = null;
  let rawStoredColorTheme: string | null = null;
  if (isOkou) {
    /* eslint-disable ccstate/no-catch-abort -- synchronous storage access cannot carry an application AbortSignal. */
    // eslint-disable-next-line no-restricted-syntax -- browser privacy policies can block localStorage, in which case Okou safely follows the system.
    try {
      rawStored = get(themeStorageGet$);
      rawStoredColorTheme = get(colorThemeStorageGet$);
    } catch {
      // Browser storage can be blocked; fall through to safe defaults.
    }
    /* eslint-enable ccstate/no-catch-abort */
  } else {
    rawStored = get(themeStorageGet$);
    rawStoredColorTheme = get(colorThemeStorageGet$);
  }
  const preference =
    bootstrapOkouThemePreference ??
    (isThemePreference(rawStored) ? rawStored : "system");
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
      const currentPreference = isOkouHostname(location.hostname)
        ? get(internalPreference$)
        : get(themeStorageGet$);
      if (
        !isThemePreference(currentPreference) ||
        currentPreference === "system"
      ) {
        const newResolved = window.matchMedia("(prefers-color-scheme: dark)")
          .matches
          ? "dark"
          : "light";
        set(internalResolved$, newResolved);
        applyTheme(newResolved);
      }
    });
});
