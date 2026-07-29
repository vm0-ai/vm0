import {
  SUPPORTED_USER_LOCALES,
  type UserLocale,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import enUSCommon from "./locales/en-US/common.json";
import enUSAgents from "./locales/en-US/agents.json";
import ptBRCommon from "./locales/pt-BR/common.json";
import ptBRAgents from "./locales/pt-BR/agents.json";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_NAMESPACE = "common";
export const SUPPORTED_LOCALES = SUPPORTED_USER_LOCALES;

export type SupportedLocale = UserLocale;

export const resources = {
  "en-US": {
    agents: enUSAgents,
    common: enUSCommon,
  },
  "pt-BR": {
    agents: ptBRAgents,
    common: ptBRCommon,
  },
} as const;
