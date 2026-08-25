import { publicBrandPresentation } from "@okouai/core/public-brand";
import { useTranslation } from "react-i18next";

import {
  AUTH_V2_SIGN_UP_RESEND_COOLDOWN_SECONDS,
  type AuthV2SignUpError,
  type AuthV2SignUpState,
} from "../../../signals/auth-v2/sign-up-flow.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";

export interface AuthV2SignUpCopy {
  readonly accessNotAllowed: string;
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
  readonly hidePassword: string;
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
  readonly showPassword: string;
  readonly signIn: string;
  readonly signUpTitle: string;
  readonly unknownError: string;
  readonly unknownMessage: string;
  readonly unknownTitle: string;
  readonly userBanned: string;
  readonly verify: string;
}

// oxlint-disable-next-line max-lines-per-function -- Declarative locale mapping is intentionally kept together for ownership auditing.
export function useAuthV2SignUpCopy(
  brandName: AuthBrandContext["brandName"],
): AuthV2SignUpCopy {
  const { t } = useTranslation();
  const supportEmail = publicBrandPresentation(
    brandName === "Okou" ? "okou" : "vm0",
  ).supportEmail;
  const resendCode = t(($) => {
    return $.auth.v2.signUp.resendCode;
  });
  return {
    accessNotAllowed: t(($) => {
      return $.auth.clerk.accessNotAllowed;
    }),
    alreadyHaveAccount: t(($) => {
      return $.auth.v2.signUp.alreadyHaveAccount;
    }),
    back: t(($) => {
      return $.auth.v2.signUp.back;
    }),
    captchaError: t(($) => {
      return $.auth.v2.signUp.captchaError;
    }),
    captchaExpired: t(($) => {
      return $.auth.v2.signUp.captchaExpired;
    }),
    captchaLoading: t(($) => {
      return $.auth.v2.signUp.captchaLoading;
    }),
    captchaSubtitle: t(($) => {
      return $.auth.v2.signUp.captchaSubtitle;
    }),
    captchaTitle: t(($) => {
      return $.auth.v2.signUp.captchaTitle;
    }),
    codeExpired: t(($) => {
      return $.auth.v2.signUp.codeExpired;
    }),
    codeLabel: t(($) => {
      return $.auth.v2.signUp.codeLabel;
    }),
    completeSubtitle: t(($) => {
      return $.auth.v2.signUp.completeSubtitle;
    }),
    completeTitle: t(($) => {
      return $.auth.v2.signUp.completeTitle;
    }),
    continue: t(($) => {
      return $.auth.v2.signUp.continue;
    }),
    description: t(($) => {
      return $.auth.v2.signUp.description;
    }),
    editEmailAddress: t(($) => {
      return $.auth.v2.signUp.editEmailAddress;
    }),
    emailAddressLabel: t(($) => {
      return $.auth.v2.signUp.emailAddressLabel;
    }),
    emailCodeSubtitle: t(($) => {
      return $.auth.v2.signUp.emailCodeSubtitle;
    }),
    emailCodeTitle: t(($) => {
      return $.auth.v2.signUp.emailCodeTitle;
    }),
    firstNameLabel: t(($) => {
      return $.auth.v2.signUp.firstNameLabel;
    }),
    googleMethod: t(($) => {
      return $.auth.v2.signUp.googleMethod;
    }),
    hidePassword: t(($) => {
      return $.auth.v2.signUp.hidePassword;
    }),
    lastNameLabel: t(($) => {
      return $.auth.v2.signUp.lastNameLabel;
    }),
    legacySignUp: t(($) => {
      return $.auth.v2.signUp.action;
    }),
    legalPrivacyOnly: t(($) => {
      return $.auth.v2.signUp.legalPrivacyOnly;
    }),
    legalRequired: t(($) => {
      return $.auth.v2.signUp.legalRequired;
    }),
    legalTermsAndPrivacy: t(($) => {
      return $.auth.v2.signUp.legalTermsAndPrivacy;
    }),
    legalTermsOnly: t(($) => {
      return $.auth.v2.signUp.legalTermsOnly;
    }),
    loading: t(($) => {
      return $.auth.loading;
    }),
    optional: t(($) => {
      return $.auth.v2.signUp.optional;
    }),
    passwordInvalid: t(($) => {
      return $.auth.v2.signUp.passwordInvalid;
    }),
    passwordLabel: t(($) => {
      return $.auth.v2.signUp.passwordLabel;
    }),
    resendCode,
    resendCodeCooldown: t(
      ($) => {
        return $.auth.v2.signUp.resendCodeCooldown;
      },
      {
        resendCode,
        seconds: AUTH_V2_SIGN_UP_RESEND_COOLDOWN_SECONDS,
      },
    ),
    restart: t(($) => {
      return $.auth.v2.signUp.restart;
    }),
    retry: t(($) => {
      return $.auth.v2.signUp.retry;
    }),
    showPassword: t(($) => {
      return $.auth.v2.signUp.showPassword;
    }),
    signIn: t(($) => {
      return $.auth.v2.signUp.signIn;
    }),
    signUpTitle: t(
      ($) => {
        return $.auth.v2.signUp.title;
      },
      { brandName },
    ),
    unknownError: t(($) => {
      return $.auth.v2.signUp.unknownError;
    }),
    unknownMessage: t(($) => {
      return $.auth.v2.signUp.unknownMessage;
    }),
    unknownTitle: t(($) => {
      return $.auth.v2.signUp.unknownTitle;
    }),
    userBanned: t(
      ($) => {
        return $.auth.clerk.userBanned;
      },
      {
        brandName,
        supportEmail,
      },
    ),
    verify: t(($) => {
      return $.auth.v2.signUp.verify;
    }),
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
  if (
    error.field === "code" &&
    (error.clerkCode?.toLowerCase().includes("expired") === true ||
      error.clerkCode?.toLowerCase().includes("timeout") === true)
  ) {
    return copy.codeExpired;
  }
  if (error.clerkCode === "not_allowed_access") {
    return copy.accessNotAllowed;
  }
  if (error.clerkCode === "user_banned") {
    return copy.userBanned;
  }
  return copy.unknownError;
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
