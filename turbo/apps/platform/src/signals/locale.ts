import { command, computed, state } from "ccstate";
import { i18n, initializeI18n } from "../i18n/index.ts";
import { DEFAULT_LOCALE, type SupportedLocale } from "../i18n/resources.ts";

const internalLocale$ = state<SupportedLocale>(DEFAULT_LOCALE);

export const locale$ = computed((get) => {
  return get(internalLocale$);
});

export const initLocale$ = command(async ({ set }, signal: AbortSignal) => {
  await initializeI18n();
  signal.throwIfAborted();
  set(internalLocale$, DEFAULT_LOCALE);
  document.documentElement.lang = DEFAULT_LOCALE;
});

export const setLocale$ = command(
  async ({ set }, locale: SupportedLocale, signal: AbortSignal) => {
    await i18n.changeLanguage(locale);
    signal.throwIfAborted();
    set(internalLocale$, locale);
    document.documentElement.lang = locale;
  },
);
