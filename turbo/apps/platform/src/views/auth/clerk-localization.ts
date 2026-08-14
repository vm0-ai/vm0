import {
  deDE,
  enUS,
  esES,
  frFR,
  hiIN,
  idID,
  itIT,
  jaJP,
  koKR,
  ptBR,
} from "@clerk/localizations";
import type { TFunction } from "i18next";
import type { SupportedLocale } from "../../i18n/resources.ts";
import type { BrandName } from "../../signals/branding.ts";

const CLERK_APPLICATION_NAME = "{{applicationName}}";

function replaceClerkApplicationName<T>(value: T, brandName: BrandName): T {
  if (typeof value === "string") {
    return value.replaceAll(CLERK_APPLICATION_NAME, brandName) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      return replaceClerkApplicationName(item, brandName);
    }) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        return [key, replaceClerkApplicationName(item, brandName)];
      }),
    ) as T;
  }
  return value;
}

export function getClerkLocalization(
  brandName: BrandName,
  locale: SupportedLocale,
  t: TFunction<"common">,
) {
  const localization =
    locale === "pt-BR"
      ? ptBR
      : locale === "ja-JP"
        ? jaJP
        : locale === "ko-KR"
          ? koKR
          : locale === "id-ID"
            ? idID
            : locale === "de-DE"
              ? deDE
              : locale === "es-ES"
                ? esES
                : locale === "it-IT"
                  ? itIT
                  : locale === "fr-FR"
                    ? frFR
                    : locale === "hi-IN"
                      ? hiIN
                      : enUS;
  const brandedLocalization =
    brandName === "Okou"
      ? replaceClerkApplicationName(localization, brandName)
      : localization;
  return {
    ...brandedLocalization,
    unstable__errors: {
      ...brandedLocalization.unstable__errors,
      not_allowed_access: t(($) => {
        return $.auth.clerk.accessNotAllowed;
      }),
      user_banned: t(
        ($) => {
          return $.auth.clerk.userBanned;
        },
        { brandName },
      ),
    },
  };
}
