import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  resources,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./resources.ts";

export const i18n = createInstance().use(initReactI18next);

export function currentLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
}

export async function initializeI18n(
  locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<void> {
  await i18n.init({
    defaultNS: DEFAULT_NAMESPACE,
    enableSelector: true,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      escapeValue: false,
    },
    lng: locale,
    resources,
    returnNull: false,
    supportedLngs: SUPPORTED_LOCALES,
  });
}
