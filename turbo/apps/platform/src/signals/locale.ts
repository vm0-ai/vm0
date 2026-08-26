import { command, computed, state } from "ccstate";
import { changeI18nLanguage, initializeI18n } from "../i18n/index.ts";
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
} from "./okou-page/settings/user-preferences.ts";

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

export const availableLocalePreferences$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.supportedLocales;
});

export const initLocale$ = command(
  async ({ set }, signal: AbortSignal): Promise<SupportedLocale | null> => {
    const requestedLocale = resolveDocumentLocale();
    const locale = await initializeI18n(requestedLocale, signal);
    signal.throwIfAborted();
    applyDocumentLocaleCopy();
    set(internalLocale$, locale);
    document.documentElement.lang = locale;
    return locale === requestedLocale ? null : requestedLocale;
  },
);

export const setLocale$ = command(
  async ({ set }, locale: SupportedLocale, signal: AbortSignal) => {
    await changeI18nLanguage(locale, signal);
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
  async (
    { get, set },
    initialLocaleLoadFailure: SupportedLocale | null,
    signal: AbortSignal,
  ) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    const supportedLocales = preferences.supportedLocales;
    const preferredLocale = preferences.locale ?? resolveDocumentLocale();
    const locale = supportedLocales.includes(preferredLocale)
      ? preferredLocale
      : DEFAULT_LOCALE;

    // This completes the cold-start presentation fallback in
    // loadInitialLocaleResources. Retrying the same failed asset pair here
    // would reject bootstrap after English was already selected. Keep the
    // preference intact so a later entrance or explicit switch can retry.
    // Remove with vm0-ai/vm0#29610 after its zero-error Sentry gate is met.
    if (locale === initialLocaleLoadFailure) {
      return;
    }
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

    const availableLocales = await get(availableLocalePreferences$);
    signal.throwIfAborted();
    if (!availableLocales.includes(locale)) {
      throw new Error(`Unsupported locale: ${locale}`);
    }

    await set(applyLocalePreference$, clerk.organization.id, locale, signal);
    await set(updateUserPreference$, { locale }, signal);
  },
);
