import {
  deDE,
  enUS,
  esES,
  frFR,
  idID,
  itIT,
  jaJP,
  koKR,
  ptBR,
} from "@clerk/localizations";
import type { TFunction } from "i18next";
import type { SupportedLocale } from "../../i18n/resources.ts";
import type { BrandName } from "../../signals/branding.ts";

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
                    : enUS;
  return {
    ...localization,
    unstable__errors: {
      ...localization.unstable__errors,
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
