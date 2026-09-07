import { publicBrandPresentation } from "@okouai/core/public-brand";
import type { TFunction } from "i18next";
import {
  clerkLocalizationForLocale,
  type ClerkLocalizationCache,
} from "../../i18n/clerk-localization.ts";
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
  clerkLocalizations: ClerkLocalizationCache,
  t: TFunction<"common">,
) {
  const supportEmail = publicBrandPresentation(
    brandName === "Okou" ? "okou" : "vm0",
  ).supportEmail;
  const localization = clerkLocalizationForLocale(clerkLocalizations, locale);
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
        { brandName, supportEmail },
      ),
    },
  };
}
