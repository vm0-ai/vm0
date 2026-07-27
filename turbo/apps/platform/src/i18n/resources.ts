import enUSCommon from "./locales/en-US/common.json";
import zhCNCommon from "./locales/zh-CN/common.json";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_NAMESPACE = "common";
export const SUPPORTED_LOCALES = ["en-US", "zh-CN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const resources = {
  "en-US": {
    common: enUSCommon,
  },
  "zh-CN": {
    common: zhCNCommon,
  },
} as const;
