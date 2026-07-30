import { command, computed, state } from "ccstate";
import { i18n, initializeI18n } from "../i18n/index.ts";
import { DEFAULT_LOCALE, type SupportedLocale } from "../i18n/resources.ts";
import {
  localeStorageKey,
  resolveDocumentLocale,
} from "../i18n/locale-storage.ts";
import { applyDocumentLocaleCopy } from "../i18n/document-copy.ts";
import { clerk$ } from "./auth.ts";
import { localStorageSignals } from "./external/local-storage.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./zero-page/settings/user-preferences.ts";

const internalLocale$ = state<SupportedLocale>(DEFAULT_LOCALE);

const writeCachedLocale$ = command(
  ({ set }, orgId: string, locale: SupportedLocale) => {
    const { set$: setCachedLocale$ } = localStorageSignals(
      localeStorageKey(orgId),
    );
    set(setCachedLocale$, locale);
  },
);

export const locale$ = computed((get) => {
  return get(internalLocale$);
});

export const localePreferenceSupportedLocales$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.locale === undefined
    ? null
    : (preferences.supportedLocales ?? null);
});

export const initLocale$ = command(async ({ set }, signal: AbortSignal) => {
  const locale = resolveDocumentLocale();
  await initializeI18n(locale);
  signal.throwIfAborted();
  applyDocumentLocaleCopy();
  set(internalLocale$, locale);
  document.documentElement.lang = locale;
});

export const setLocale$ = command(
  async ({ set }, locale: SupportedLocale, signal: AbortSignal) => {
    await i18n.changeLanguage(locale);
    signal.throwIfAborted();
    applyDocumentLocaleCopy();
    set(internalLocale$, locale);
    document.documentElement.lang = locale;
  },
);

const applyLocalePreference$ = command(
  async (
    { get, set },
    orgId: string,
    locale: SupportedLocale,
    signal: AbortSignal,
  ) => {
    if (get(internalLocale$) !== locale) {
      await set(setLocale$, locale, signal);
    }
    set(writeCachedLocale$, orgId, locale);
  },
);

export const syncLocalePreference$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    if (
      preferences.locale === undefined ||
      preferences.supportedLocales === undefined
    ) {
      return;
    }

    const preferredLocale = preferences.locale ?? resolveDocumentLocale();
    const locale = preferences.supportedLocales.includes(preferredLocale)
      ? preferredLocale
      : DEFAULT_LOCALE;
    await set(applyLocalePreference$, clerk.organization.id, locale, signal);

    if (preferences.locale === null) {
      await set(updateUserPreference$, { locale }, signal);
    }
  },
);

export const updateLocalePreference$ = command(
  async ({ get, set }, locale: SupportedLocale, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      throw new Error("Language preferences require an active workspace");
    }

    const supportedLocales = await get(localePreferenceSupportedLocales$);
    signal.throwIfAborted();
    if (supportedLocales?.includes(locale) !== true) {
      throw new Error(`Unsupported locale: ${locale}`);
    }

    await set(applyLocalePreference$, clerk.organization.id, locale, signal);
    await set(updateUserPreference$, { locale }, signal);
  },
);
