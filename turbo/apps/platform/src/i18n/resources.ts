import {
  SUPPORTED_USER_LOCALES,
  type UserLocale,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import enUSCommon from "./locales/en-US/common.json";
import enUSAgents from "./locales/en-US/agents.json";
import ptBRCommon from "./locales/pt-BR/common.json";
import ptBRAgents from "./locales/pt-BR/agents.json";
import jaJPCommon from "./locales/ja-JP/common.json";
import jaJPAgents from "./locales/ja-JP/agents.json";
import koKRCommon from "./locales/ko-KR/common.json";
import koKRAgents from "./locales/ko-KR/agents.json";
import idIDCommon from "./locales/id-ID/common.json";
import idIDAgents from "./locales/id-ID/agents.json";
import deDECommon from "./locales/de-DE/common.json";
import deDEAgents from "./locales/de-DE/agents.json";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_NAMESPACE = "common";
export const SUPPORTED_LOCALES = SUPPORTED_USER_LOCALES;

export type SupportedLocale = UserLocale;

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => {
    return locale === value;
  });
}

export const resources = {
  "en-US": {
    agents: enUSAgents,
    common: enUSCommon,
  },
  "pt-BR": {
    agents: ptBRAgents,
    common: ptBRCommon,
  },
  "ja-JP": {
    agents: jaJPAgents,
    common: jaJPCommon,
  },
  "ko-KR": {
    agents: koKRAgents,
    common: koKRCommon,
  },
  "id-ID": {
    agents: idIDAgents,
    common: idIDCommon,
  },
  "de-DE": {
    agents: deDEAgents,
    common: deDECommon,
  },
} as const;
