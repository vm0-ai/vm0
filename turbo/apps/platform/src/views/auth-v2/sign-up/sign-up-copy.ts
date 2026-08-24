import { enUS } from "@clerk/localizations";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  AUTH_V2_SIGN_UP_RESEND_COOLDOWN_SECONDS,
  type AuthV2SignUpError,
  type AuthV2SignUpState,
} from "../../../signals/auth-v2/sign-up-flow.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";
import { locale$ } from "../../../signals/locale.ts";
import { getClerkLocalization } from "../../auth/clerk-localization.ts";

type ClerkLocalization = ReturnType<typeof getClerkLocalization>;

const CLERK_PROVIDER = "{{provider|titleize}}";

export interface AuthV2SignUpCopy {
  readonly alreadyHaveAccount: string;
  readonly back: string;
  readonly captchaError: string;
  readonly captchaExpired: string;
  readonly captchaLoading: string;
  readonly captchaSubtitle: string;
  readonly captchaTitle: string;
  readonly codeExpired: string;
  readonly codeLabel: string;
  readonly completeSubtitle: string;
  readonly completeTitle: string;
  readonly continue: string;
  readonly description: string;
  readonly editEmailAddress: string;
  readonly emailAddressLabel: string;
  readonly emailCodeSubtitle: string;
  readonly emailCodeTitle: string;
  readonly firstNameLabel: string;
  readonly googleMethod: string;
  readonly lastNameLabel: string;
  readonly legacySignUp: string;
  readonly legalPrivacyOnly: string;
  readonly legalRequired: string;
  readonly legalTermsAndPrivacy: string;
  readonly legalTermsOnly: string;
  readonly loading: string;
  readonly optional: string;
  readonly passwordInvalid: string;
  readonly passwordLabel: string;
  readonly resendCode: string;
  readonly resendCodeCooldown: string;
  readonly restart: string;
  readonly retry: string;
  readonly signIn: string;
  readonly signUpTitle: string;
  readonly unknownError: string;
  readonly unknownMessage: string;
  readonly unknownTitle: string;
  readonly verify: string;
}

function localizedString(value: unknown, fallback: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof fallback === "string" ? fallback : "";
}

function formCopy(localization: ClerkLocalization) {
  return {
    back: localizedString(localization.backButton, enUS.backButton),
    codeLabel: localizedString(
      localization.signUp?.emailCode?.formTitle,
      enUS.signUp?.emailCode?.formTitle,
    ),
    continue: localizedString(
      localization.formButtonPrimary,
      enUS.formButtonPrimary,
    ),
    editEmailAddress: localizedString(
      localization.identityPreviewEditButton__emailAddress,
      enUS.identityPreviewEditButton__emailAddress,
    ),
    emailAddressLabel: localizedString(
      localization.formFieldLabel__emailAddress,
      enUS.formFieldLabel__emailAddress,
    ),
    firstNameLabel: localizedString(
      localization.formFieldLabel__firstName,
      enUS.formFieldLabel__firstName,
    ),
    lastNameLabel: localizedString(
      localization.formFieldLabel__lastName,
      enUS.formFieldLabel__lastName,
    ),
    optional: localizedString(
      localization.formFieldHintText__optional,
      enUS.formFieldHintText__optional,
    ),
    passwordLabel: localizedString(
      localization.formFieldLabel__password,
      enUS.formFieldLabel__password,
    ),
    verify: localizedString(
      localization.formButtonPrimary__verify,
      enUS.formButtonPrimary__verify,
    ),
  };
}

function startCopy(localization: ClerkLocalization) {
  const start = localization.signUp?.start;
  const fallback = enUS.signUp?.start;
  return {
    alreadyHaveAccount: localizedString(
      start?.actionText,
      fallback?.actionText,
    ),
    description: localizedString(start?.subtitle, fallback?.subtitle),
    signIn: localizedString(start?.actionLink, fallback?.actionLink),
  };
}

function externalMethodCopy(localization: ClerkLocalization) {
  return {
    googleMethod: localizedString(
      localization.socialButtonsBlockButton,
      enUS.socialButtonsBlockButton,
    ).replaceAll(CLERK_PROVIDER, "Google"),
  };
}

function emailCodeCopy(localization: ClerkLocalization) {
  const emailCode = localization.signUp?.emailCode;
  const fallback = enUS.signUp?.emailCode;
  return {
    emailCodeSubtitle: localizedString(emailCode?.subtitle, fallback?.subtitle),
    emailCodeTitle: localizedString(emailCode?.title, fallback?.title),
    resendCode: localizedString(
      emailCode?.resendButton,
      fallback?.resendButton,
    ),
  };
}

function legalCopy(localization: ClerkLocalization) {
  const legal = localization.signUp?.legalConsent;
  const fallback = enUS.signUp?.legalConsent;
  return {
    legalPrivacyOnly: localizedString(
      legal?.checkbox?.label__onlyPrivacyPolicy,
      fallback?.checkbox?.label__onlyPrivacyPolicy,
    ),
    legalRequired: localizedString(
      legal?.continue?.subtitle,
      fallback?.continue?.subtitle,
    ),
    legalTermsAndPrivacy: localizedString(
      legal?.checkbox?.label__termsOfServiceAndPrivacyPolicy,
      fallback?.checkbox?.label__termsOfServiceAndPrivacyPolicy,
    ),
    legalTermsOnly: localizedString(
      legal?.checkbox?.label__onlyTermsOfService,
      fallback?.checkbox?.label__onlyTermsOfService,
    ),
  };
}

function captchaCopy(localization: ClerkLocalization) {
  const protectCheck = localization.signUp?.protectCheck;
  const fallbackProtectCheck = enUS.signUp?.protectCheck;
  return {
    captchaError: localizedString(
      localization.unstable__errors?.captcha_unavailable,
      enUS.unstable__errors?.captcha_unavailable,
    ),
    captchaLoading: localizedString(
      protectCheck?.loading,
      fallbackProtectCheck?.loading,
    ),
    captchaSubtitle: localizedString(
      protectCheck?.subtitle,
      fallbackProtectCheck?.subtitle,
    ),
    captchaTitle: localizedString(
      protectCheck?.title,
      fallbackProtectCheck?.title,
    ),
    retry: localizedString(
      protectCheck?.retryButton,
      fallbackProtectCheck?.retryButton,
    ),
  };
}

function completionCopy(localization: ClerkLocalization) {
  return {
    completeSubtitle: localizedString(
      localization.signUp?.emailLink?.loading?.title,
      enUS.signUp?.emailLink?.loading?.title,
    ),
    completeTitle: localizedString(
      localization.signUp?.emailLink?.verified?.title,
      enUS.signUp?.emailLink?.verified?.title,
    ),
    passwordInvalid: localizedString(
      localization.unstable__errors?.form_password_not_strong_enough,
      enUS.unstable__errors?.form_password_not_strong_enough,
    ),
  };
}

function recoveryCopy(localization: ClerkLocalization) {
  const restrictedAccess = localization.signUp?.restrictedAccess;
  const fallbackRestrictedAccess = enUS.signUp?.restrictedAccess;
  return {
    restart: localizedString(
      localization.footerActionLink__useAnotherMethod,
      enUS.footerActionLink__useAnotherMethod,
    ),
    unknownError: localizedString(
      localization.unstable__errors?.action_blocked,
      enUS.unstable__errors?.action_blocked,
    ),
    unknownMessage: localizedString(
      restrictedAccess?.subtitle,
      fallbackRestrictedAccess?.subtitle,
    ),
    unknownTitle: localizedString(
      restrictedAccess?.title,
      fallbackRestrictedAccess?.title,
    ),
  };
}

export function useAuthV2SignUpCopy(
  brandName: AuthBrandContext["brandName"],
): AuthV2SignUpCopy {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  const localization = getClerkLocalization(brandName, locale, t);
  return {
    ...formCopy(localization),
    ...startCopy(localization),
    ...externalMethodCopy(localization),
    ...emailCodeCopy(localization),
    ...legalCopy(localization),
    ...captchaCopy(localization),
    ...completionCopy(localization),
    ...recoveryCopy(localization),
    captchaExpired: t(($) => {
      return $.auth.v2.signUp.captchaExpired;
    }),
    codeExpired: t(($) => {
      return $.auth.v2.signUp.codeExpired;
    }),
    legacySignUp: t(($) => {
      return $.auth.v2.signUp.action;
    }),
    loading: t(($) => {
      return $.auth.loading;
    }),
    resendCodeCooldown: t(
      ($) => {
        return $.auth.v2.signUp.resendCodeCooldown;
      },
      {
        count: AUTH_V2_SIGN_UP_RESEND_COOLDOWN_SECONDS,
        resendCode: emailCodeCopy(localization).resendCode,
      },
    ),
    signUpTitle: t(
      ($) => {
        return $.auth.v2.signUp.title;
      },
      { brandName },
    ),
  };
}

export function signUpErrorMessage(
  error: AuthV2SignUpError,
  copy: AuthV2SignUpCopy,
): string {
  if (error.code === "legal-required") {
    return copy.legalRequired;
  }
  if (error.code === "password-invalid") {
    return copy.passwordInvalid;
  }
  return error.message ?? copy.unknownError;
}

export function signUpCardDescription(
  flowState: AuthV2SignUpState,
  copy: AuthV2SignUpCopy,
): string {
  if (flowState.status === "loading") {
    return copy.loading;
  }
  if (flowState.status === "complete") {
    return copy.completeSubtitle;
  }
  if (flowState.status === "transfer") {
    return copy.alreadyHaveAccount;
  }
  if (flowState.status === "unknown") {
    return copy.unknownMessage;
  }
  if (flowState.step === "email-code") {
    return copy.emailCodeSubtitle;
  }
  return copy.description;
}

export function resendCodeLabel(
  coolingDown: boolean,
  copy: AuthV2SignUpCopy,
): string {
  return coolingDown ? copy.resendCodeCooldown : copy.resendCode;
}
