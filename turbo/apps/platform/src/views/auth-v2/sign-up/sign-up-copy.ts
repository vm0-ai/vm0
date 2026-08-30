import { publicBrandPresentation } from "@okouai/core/public-brand";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type {
  AuthV2SignUpError,
  AuthV2SignUpState,
} from "../../../signals/auth-v2/sign-up-flow.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";

export interface AuthV2SignUpCopy {
  readonly accessNotAllowed: string;
  readonly alreadyHaveAccount: string;
  readonly appleMethod: string;
  readonly appleProvider: string;
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
  readonly emailAddressPlaceholder: string;
  readonly emailCodeSubtitle: string;
  readonly emailCodeTitle: string;
  readonly firstNameLabel: string;
  readonly firstNamePlaceholder: string;
  readonly googleMethod: string;
  readonly googleProvider: string;
  readonly hidePassword: string;
  readonly lastNameLabel: string;
  readonly lastNamePlaceholder: string;
  readonly legalPrivacyOnly: string;
  readonly legalRequired: string;
  readonly legalTermsAndPrivacy: string;
  readonly legalTermsOnly: string;
  readonly loading: string;
  readonly optional: string;
  readonly passwordInvalid: string;
  readonly passwordLabel: string;
  readonly passwordPlaceholder: string;
  readonly resendCode: string;
  readonly resendCodeCooldown: (remainingSeconds: number) => string;
  readonly restart: string;
  readonly retry: string;
  readonly showPassword: string;
  readonly signIn: string;
  readonly signUpTitle: string;
  readonly separator: string;
  readonly unknownError: string;
  readonly unknownMessage: string;
  readonly unknownTitle: string;
  readonly userBanned: string;
  readonly verify: string;
}

function signUpDetailsCopy(
  t: TFunction<"common">,
  brandName: AuthBrandContext["brandName"],
) {
  return {
    alreadyHaveAccount: t(($) => {
      return $.auth.v2.signUp.alreadyHaveAccount;
    }),
    appleMethod: t(($) => {
      return $.auth.v2.signUp.appleMethod;
    }),
    appleProvider: t(($) => {
      return $.auth.v2.oauthProviders.apple;
    }),
    continue: t(($) => {
      return $.auth.v2.signUp.continue;
    }),
    description: t(
      ($) => {
        return $.auth.v2.signUp.description;
      },
      { brandName },
    ),
    emailAddressLabel: t(($) => {
      return $.auth.v2.signUp.emailAddressLabel;
    }),
    emailAddressPlaceholder: t(($) => {
      return $.auth.v2.signUp.emailAddressPlaceholder;
    }),
    firstNameLabel: t(($) => {
      return $.auth.v2.signUp.firstNameLabel;
    }),
    firstNamePlaceholder: t(($) => {
      return $.auth.v2.signUp.firstNamePlaceholder;
    }),
    googleMethod: t(($) => {
      return $.auth.v2.signUp.googleMethod;
    }),
    googleProvider: t(($) => {
      return $.auth.v2.oauthProviders.google;
    }),
    hidePassword: t(($) => {
      return $.auth.v2.signUp.hidePassword;
    }),
    lastNameLabel: t(($) => {
      return $.auth.v2.signUp.lastNameLabel;
    }),
    lastNamePlaceholder: t(($) => {
      return $.auth.v2.signUp.lastNamePlaceholder;
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
    optional: t(($) => {
      return $.auth.v2.signUp.optional;
    }),
    passwordInvalid: t(($) => {
      return $.auth.v2.signUp.passwordInvalid;
    }),
    passwordLabel: t(($) => {
      return $.auth.v2.signUp.passwordLabel;
    }),
    passwordPlaceholder: t(($) => {
      return $.auth.v2.signUp.passwordPlaceholder;
    }),
    showPassword: t(($) => {
      return $.auth.v2.signUp.showPassword;
    }),
    signIn: t(($) => {
      return $.auth.v2.signUp.signIn;
    }),
    separator: t(($) => {
      return $.auth.v2.signUp.separator;
    }),
    signUpTitle: t(
      ($) => {
        return $.auth.v2.signUp.title;
      },
      { brandName },
    ),
  };
}

function signUpVerificationCopy(
  t: TFunction<"common">,
  brandName: AuthBrandContext["brandName"],
) {
  const resendCode = t(($) => {
    return $.auth.v2.signUp.resendCode;
  });
  return {
    back: t(($) => {
      return $.auth.v2.signUp.back;
    }),
    codeExpired: t(($) => {
      return $.auth.v2.signUp.codeExpired;
    }),
    codeLabel: t(($) => {
      return $.auth.v2.signUp.codeLabel;
    }),
    editEmailAddress: t(($) => {
      return $.auth.v2.signUp.editEmailAddress;
    }),
    emailCodeSubtitle: t(
      ($) => {
        return $.auth.v2.signUp.emailCodeSubtitle;
      },
      { brandName },
    ),
    emailCodeTitle: t(($) => {
      return $.auth.v2.signUp.emailCodeTitle;
    }),
    resendCode,
    resendCodeCooldown: (remainingSeconds: number) => {
      return t(
        ($) => {
          return $.auth.v2.signUp.resendCodeCooldown;
        },
        {
          resendCode,
          seconds: remainingSeconds,
        },
      );
    },
    retry: t(($) => {
      return $.auth.v2.signUp.retry;
    }),
    verify: t(($) => {
      return $.auth.v2.signUp.verify;
    }),
  };
}

function signUpTerminalCopy(
  t: TFunction<"common">,
  brandName: AuthBrandContext["brandName"],
) {
  const supportEmail = publicBrandPresentation(
    brandName === "Okou" ? "okou" : "vm0",
  ).supportEmail;
  return {
    accessNotAllowed: t(($) => {
      return $.auth.clerk.accessNotAllowed;
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
    completeSubtitle: t(($) => {
      return $.auth.v2.signUp.completeSubtitle;
    }),
    completeTitle: t(($) => {
      return $.auth.v2.signUp.completeTitle;
    }),
    loading: t(($) => {
      return $.auth.loading;
    }),
    restart: t(($) => {
      return $.auth.v2.signUp.restart;
    }),
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
  };
}

export function useAuthV2SignUpCopy(
  brandName: AuthBrandContext["brandName"],
): AuthV2SignUpCopy {
  const { t } = useTranslation();
  return {
    ...signUpDetailsCopy(t, brandName),
    ...signUpVerificationCopy(t, brandName),
    ...signUpTerminalCopy(t, brandName),
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

export function signUpCardTitle(
  flowState: AuthV2SignUpState,
  copy: AuthV2SignUpCopy,
): string {
  if (flowState.status === "complete") {
    return copy.completeTitle;
  }
  if (flowState.status === "unknown") {
    return copy.unknownTitle;
  }
  if (flowState.status === "incomplete" && flowState.step === "email-code") {
    return copy.emailCodeTitle;
  }
  return copy.signUpTitle;
}

export function resendCodeLabel(
  remainingSeconds: number,
  copy: AuthV2SignUpCopy,
): string {
  return remainingSeconds > 0
    ? copy.resendCodeCooldown(remainingSeconds)
    : copy.resendCode;
}
