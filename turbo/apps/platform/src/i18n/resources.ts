import {
  SUPPORTED_USER_LOCALES,
  type UserLocale,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import enUSCommon from "./locales/en-US/common.json";
import ptBRCommon from "./locales/pt-BR/common.json";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_NAMESPACE = "common";
export const SUPPORTED_LOCALES = SUPPORTED_USER_LOCALES;

export type SupportedLocale = UserLocale;

export const resources = {
  "en-US": {
    common: enUSCommon,
  },
  "pt-BR": {
    common: ptBRCommon,
  },
} as const;
