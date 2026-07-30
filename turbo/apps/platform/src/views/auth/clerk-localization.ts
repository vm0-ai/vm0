import { enUS, koKR, ptBR } from "@clerk/localizations";
import type { TFunction } from "i18next";
import type { SupportedLocale } from "../../i18n/resources.ts";
import type { BrandName } from "../../signals/branding.ts";

export function getClerkLocalization(
  brandName: BrandName,
  locale: SupportedLocale,
  t: TFunction<"common">,
) {
  const localization =
    locale === "pt-BR" ? ptBR : locale === "ko-KR" ? koKR : enUS;
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
