import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  resources,
  SUPPORTED_LOCALES,
} from "./resources.ts";

export const i18n = createInstance().use(initReactI18next);

export async function initializeI18n(): Promise<void> {
  await i18n.init({
    defaultNS: DEFAULT_NAMESPACE,
    enableSelector: true,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      escapeValue: false,
    },
    lng: DEFAULT_LOCALE,
    resources,
    returnNull: false,
    supportedLngs: SUPPORTED_LOCALES,
  });
}
