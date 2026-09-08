import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
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
  mode: "sign-in" | "sign-up",
  brandName: BrandName,
  locale: SupportedLocale,
  clerkLocalizations: ClerkLocalizationCache,
  t: TFunction<"common">,
) {
  const supportEmail = PUBLIC_BRAND_PRESENTATION.supportEmail;
  const localization = clerkLocalizationForLocale(clerkLocalizations, locale);
  const brandedLocalization = replaceClerkApplicationName(
    localization,
    brandName,
  );
  const formCodeIncorrect =
    mode === "sign-in"
      ? t(($) => {
          return $.auth.v2.signIn.invalidCode;
        })
      : t(($) => {
          return $.auth.v2.signUp.unknownError;
        });
  return {
    ...brandedLocalization,
    signIn: {
      ...brandedLocalization.signIn,
      resetPassword: {
        ...brandedLocalization.signIn?.resetPassword,
        formButtonPrimary: t(($) => {
          return $.auth.v2.signIn.resetPassword;
        }),
      },
    },
    unstable__errors: {
      ...brandedLocalization.unstable__errors,
      form_code_incorrect: formCodeIncorrect,
      ...(mode === "sign-in"
        ? {
            form_password_incorrect: t(($) => {
              return $.auth.v2.signIn.unknownError;
            }),
          }
        : {
            form_password_not_strong_enough: t(($) => {
              return $.auth.v2.signUp.passwordInvalid;
            }),
          }),
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
