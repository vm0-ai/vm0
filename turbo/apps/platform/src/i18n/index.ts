import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  resolveAssistantNameForHostname,
  resolveBrandNameForHostname,
} from "../signals/branding.ts";
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  resources,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./resources.ts";

export const i18n = createInstance().use(initReactI18next);

// bootstrap$ awaits initializeI18n before rendering production callers.
export function currentLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language;
}

export async function initializeI18n(
  locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<void> {
  const hostname = location.hostname;
  await i18n.init({
    defaultNS: DEFAULT_NAMESPACE,
    enableSelector: true,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      defaultVariables: {
        assistantName: resolveAssistantNameForHostname(hostname),
        brandName: resolveBrandNameForHostname(hostname),
      },
      escapeValue: false,
    },
    lng: locale,
    resources,
    returnNull: false,
    supportedLngs: SUPPORTED_LOCALES,
  });
}
