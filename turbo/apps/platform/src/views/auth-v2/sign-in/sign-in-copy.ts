import { publicBrandPresentation } from "@okouai/core/public-brand";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type {
  AuthV2SignInError,
  AuthV2SignInFactor,
  AuthV2SignInState,
} from "../../../signals/auth-v2/sign-in-flow.ts";
import {
  resolveAuthBrandContext,
  type AuthBrandContext,
} from "../../../signals/auth.ts";

export interface AuthV2SignInCopy {
  readonly accessNotAllowed: string;
  readonly addAccount: string;
  readonly appleMethod: string;
  readonly appleProvider: string;
  readonly back: string;
  readonly chooseAccountSubtitle: string;
  readonly chooseAccountTitle: string;
  readonly chooseMethodSubtitle: string;
  readonly chooseMethodTitle: string;
  readonly clientTrustNotice: string;
  readonly codeExpired: string;
  readonly codeLabel: string;
  readonly completeSubtitle: string;
  readonly completeTitle: string;
  readonly confirmPasswordLabel: string;
  readonly continue: string;
  readonly editIdentifier: string;
  readonly emailAddressLabel: string;
  readonly emailAddressPlaceholder: string;
  readonly emailCodeMethod: (identifier: string) => string;
  readonly emailCodeSubtitle: string;
  readonly emailCodeTitle: string;
  readonly emailSupport: string;
  readonly forgotPassword: string;
  readonly getHelp: string;
  readonly googleMethod: string;
  readonly googleProvider: string;
  readonly hidePassword: string;
  readonly helpDescription: string;
  readonly helpTitle: string;
  readonly identifierLabel: string;
  readonly identifierPlaceholder: string;
  readonly loading: string;
  readonly methodsHelpPrompt: string;
  readonly newPasswordLabel: string;
  readonly newPasswordSubtitle: string;
  readonly newPasswordTitle: string;
  readonly noAccount: string;
  readonly noMethodsMessage: string;
  readonly noMethodsTitle: string;
  readonly passwordLabel: string;
  readonly passwordMethod: string;
  readonly passwordMismatch: string;
  readonly passwordPlaceholder: string;
  readonly passwordResetMethod: string;
  readonly passwordSubtitle: string;
  readonly passwordTitle: string;
  readonly passkeyCancelled: string;
  readonly passkeyMethod: string;
  readonly passkeyUnavailable: string;
  readonly resendCode: string;
  readonly resendCodeCooldown: (remainingSeconds: number) => string;
  readonly recoveryMethodsDivider: string;
  readonly recoveryTitle: string;
  readonly resetPassword: string;
  readonly resetPasswordCodeSubtitle: string;
  readonly resetPasswordCodeTitle: string;
  readonly showPassword: string;
  readonly signOutOfOtherSessions: string;
  readonly signInTitle: string;
  readonly signUp: string;
  readonly separator: string;
  readonly startSubtitle: string;
  readonly supportEmailHref: string;
  readonly unknownError: string;
  readonly useAnotherMethod: string;
  readonly userBanned: string;
  readonly usernameLabel: string;
  readonly usernamePlaceholder: string;
  readonly verify: string;
}

function signInEntryCopy(
  t: TFunction<"common">,
  brandName: AuthBrandContext["brandName"],
) {
  return {
    addAccount: t(($) => {
      return $.auth.v2.signIn.addAccount;
    }),
    appleMethod: t(($) => {
      return $.auth.v2.signIn.appleMethod;
    }),
    appleProvider: t(($) => {
      return $.auth.v2.oauthProviders.apple;
    }),
    chooseAccountSubtitle: t(($) => {
      return $.auth.v2.signIn.chooseAccountSubtitle;
    }),
    chooseAccountTitle: t(($) => {
      return $.auth.v2.signIn.chooseAccountTitle;
    }),
    chooseMethodSubtitle: t(($) => {
      return $.auth.v2.signIn.chooseMethodSubtitle;
    }),
    chooseMethodTitle: t(($) => {
      return $.auth.v2.signIn.chooseMethodTitle;
    }),
    editIdentifier: t(($) => {
      return $.auth.v2.signIn.editIdentifier;
    }),
    emailAddressLabel: t(($) => {
      return $.auth.v2.signIn.emailAddressLabel;
    }),
    emailAddressPlaceholder: t(($) => {
      return $.auth.v2.signIn.emailAddressPlaceholder;
    }),
    emailCodeMethod: (identifier: string) => {
      return t(
        ($) => {
          return $.auth.v2.signIn.emailCodeMethod;
        },
        { identifier },
      );
    },
    googleMethod: t(($) => {
      return $.auth.v2.signIn.googleMethod;
    }),
    googleProvider: t(($) => {
      return $.auth.v2.oauthProviders.google;
    }),
    identifierLabel: t(($) => {
      return $.auth.v2.signIn.identifierLabel;
    }),
    identifierPlaceholder: t(($) => {
      return $.auth.v2.signIn.identifierPlaceholder;
    }),
    noAccount: t(($) => {
      return $.auth.v2.signIn.noAccount;
    }),
    passwordMethod: t(($) => {
      return $.auth.v2.signIn.passwordMethod;
    }),
    passwordResetMethod: t(($) => {
      return $.auth.v2.signIn.passwordResetMethod;
    }),
    passkeyMethod: t(($) => {
      return $.auth.v2.signIn.passkeyMethod;
    }),
    signUp: t(($) => {
      return $.auth.v2.signIn.signUp;
    }),
    separator: t(($) => {
      return $.auth.v2.signIn.separator;
    }),
    startSubtitle: t(
      ($) => {
        return $.auth.v2.signIn.startSubtitle;
      },
      { brandName },
    ),
    useAnotherMethod: t(($) => {
      return $.auth.v2.signIn.useAnotherMethod;
    }),
    usernameLabel: t(($) => {
      return $.auth.v2.signIn.usernameLabel;
    }),
    usernamePlaceholder: t(($) => {
      return $.auth.v2.signIn.usernamePlaceholder;
    }),
  };
}

function signInCodeCopy(
  t: TFunction<"common">,
  brandName: AuthBrandContext["brandName"],
) {
  const resendCode = t(($) => {
    return $.auth.v2.signIn.resendCode;
  });
  return {
    back: t(($) => {
      return $.auth.v2.signIn.back;
    }),
    clientTrustNotice: t(($) => {
      return $.auth.v2.signIn.clientTrustNotice;
    }),
    codeExpired: t(($) => {
      return $.auth.v2.signIn.codeExpired;
    }),
    codeLabel: t(($) => {
      return $.auth.v2.signIn.codeLabel;
    }),
    continue: t(($) => {
      return $.auth.v2.signIn.continue;
    }),
    emailCodeSubtitle: t(
      ($) => {
        return $.auth.v2.signIn.emailCodeSubtitle;
      },
      { brandName },
    ),
    emailCodeTitle: t(($) => {
      return $.auth.v2.signIn.emailCodeTitle;
    }),
    resendCode,
    resendCodeCooldown: (remainingSeconds: number) => {
      return t(
        ($) => {
          return $.auth.v2.signIn.resendCodeCooldown;
        },
        {
          resendCode,
          seconds: remainingSeconds,
        },
      );
    },
    resetPasswordCodeSubtitle: t(($) => {
      return $.auth.v2.signIn.resetPasswordCodeSubtitle;
    }),
    resetPasswordCodeTitle: t(($) => {
      return $.auth.v2.signIn.resetPasswordCodeTitle;
    }),
    verify: t(($) => {
      return $.auth.v2.signIn.verify;
    }),
  };
}

function signInPasswordCopy(
  t: TFunction<"common">,
  brandName: AuthBrandContext["brandName"],
) {
  return {
    confirmPasswordLabel: t(($) => {
      return $.auth.v2.signIn.confirmPasswordLabel;
    }),
    forgotPassword: t(($) => {
      return $.auth.v2.signIn.forgotPassword;
    }),
    hidePassword: t(($) => {
      return $.auth.v2.signIn.hidePassword;
    }),
    newPasswordLabel: t(($) => {
      return $.auth.v2.signIn.newPasswordLabel;
    }),
    newPasswordSubtitle: t(($) => {
      return $.auth.v2.signIn.newPasswordSubtitle;
    }),
    newPasswordTitle: t(($) => {
      return $.auth.v2.signIn.newPasswordTitle;
    }),
    passwordLabel: t(($) => {
      return $.auth.v2.signIn.passwordLabel;
    }),
    passwordMismatch: t(($) => {
      return $.auth.v2.signIn.passwordMismatch;
    }),
    passwordPlaceholder: t(($) => {
      return $.auth.v2.signIn.passwordPlaceholder;
    }),
    passwordSubtitle: t(
      ($) => {
        return $.auth.v2.signIn.passwordSubtitle;
      },
      { brandName },
    ),
    passwordTitle: t(($) => {
      return $.auth.v2.signIn.passwordTitle;
    }),
    recoveryMethodsDivider: t(($) => {
      return $.auth.v2.signIn.recoveryMethodsDivider;
    }),
    recoveryTitle: t(($) => {
      return $.auth.v2.signIn.recoveryTitle;
    }),
    resetPassword: t(($) => {
      return $.auth.v2.signIn.resetPassword;
    }),
    showPassword: t(($) => {
      return $.auth.v2.signIn.showPassword;
    }),
    signOutOfOtherSessions: t(($) => {
      return $.auth.v2.signIn.signOutOfOtherSessions;
    }),
  };
}

function signInTerminalCopy(
  t: TFunction<"common">,
  authBrand: AuthBrandContext,
) {
  const supportEmail = publicBrandPresentation(
    authBrand.brandName === "Okou" ? "okou" : "vm0",
  ).supportEmail;
  return {
    accessNotAllowed: t(($) => {
      return $.auth.clerk.accessNotAllowed;
    }),
    completeSubtitle: t(
      ($) => {
        return $.auth.v2.signIn.completeSubtitle;
      },
      { brandName: authBrand.brandName },
    ),
    completeTitle: t(($) => {
      return $.auth.v2.signIn.completeTitle;
    }),
    emailSupport: t(($) => {
      return $.auth.v2.signIn.emailSupport;
    }),
    getHelp: t(($) => {
      return $.auth.v2.signIn.getHelp;
    }),
    helpDescription: t(($) => {
      return $.auth.v2.signIn.helpDescription;
    }),
    helpTitle: t(($) => {
      return $.auth.v2.signIn.helpTitle;
    }),
    loading: t(($) => {
      return $.auth.loading;
    }),
    methodsHelpPrompt: t(($) => {
      return $.auth.v2.signIn.methodsHelpPrompt;
    }),
    noMethodsMessage: t(($) => {
      return $.auth.v2.signIn.noMethodsMessage;
    }),
    noMethodsTitle: t(($) => {
      return $.auth.v2.signIn.noMethodsTitle;
    }),
    passkeyCancelled: t(($) => {
      return $.auth.v2.signIn.passkeyCancelled;
    }),
    passkeyUnavailable: t(($) => {
      return $.auth.v2.signIn.passkeyUnavailable;
    }),
    signInTitle: t(
      ($) => {
        return $.auth.v2.signIn.title;
      },
      { brandName: authBrand.brandName },
    ),
    supportEmailHref: `mailto:${supportEmail}`,
    unknownError: t(($) => {
      return $.auth.v2.signIn.unknownError;
    }),
    userBanned: t(
      ($) => {
        return $.auth.clerk.userBanned;
      },
      {
        brandName: authBrand.brandName,
        supportEmail,
      },
    ),
  };
}

export function useAuthV2SignInCopy(): AuthV2SignInCopy {
  const { t } = useTranslation();
  const authBrand = resolveAuthBrandContext();
  return {
    ...signInEntryCopy(t, authBrand.brandName),
    ...signInCodeCopy(t, authBrand.brandName),
    ...signInPasswordCopy(t, authBrand.brandName),
    ...signInTerminalCopy(t, authBrand),
  };
}

export function signInErrorMessage(
  error: AuthV2SignInError,
  copy: AuthV2SignInCopy,
): string {
  if (error.code === "password-mismatch") {
    return copy.passwordMismatch;
  }
  if (error.code === "passkey-cancelled") {
    return copy.passkeyCancelled;
  }
  if (error.code === "passkey-unavailable") {
    return copy.passkeyUnavailable;
  }
  if (error.code === "code-expired") {
    return copy.codeExpired;
  }
  if (error.code === "access-not-allowed") {
    return copy.accessNotAllowed;
  }
  if (error.code === "user-banned") {
    return copy.userBanned;
  }
  return copy.unknownError;
}

export function signInCardDescription(
  flowState: AuthV2SignInState,
  copy: AuthV2SignInCopy,
): string | null {
  if (flowState.status === "loading") {
    return copy.loading;
  }
  if (flowState.status === "complete") {
    return copy.completeSubtitle;
  }
  if (flowState.status === "transfer") {
    return copy.noAccount;
  }
  if (flowState.status === "unknown") {
    return copy.noMethodsMessage;
  }
  if (flowState.step === "choose-factor") {
    return copy.chooseMethodSubtitle;
  }
  if (flowState.step === "choose-session") {
    return copy.chooseAccountSubtitle;
  }
  if (flowState.step === "password") {
    return copy.passwordSubtitle;
  }
  if (
    flowState.step === "password-recovery" ||
    flowState.step === "new-password"
  ) {
    return null;
  }
  if (flowState.step === "help") {
    return copy.helpDescription;
  }
  if (
    flowState.step === "email-code" ||
    flowState.step === "client-trust-code"
  ) {
    return copy.emailCodeSubtitle;
  }
  if (flowState.step === "password-reset-code") {
    return copy.resetPasswordCodeSubtitle;
  }
  return copy.startSubtitle;
}

export function signInCardTitle(
  flowState: AuthV2SignInState,
  copy: AuthV2SignInCopy,
): string {
  if (flowState.status === "complete") {
    return copy.completeTitle;
  }
  if (flowState.status === "unknown") {
    return copy.noMethodsTitle;
  }
  if (flowState.status !== "incomplete") {
    return copy.signInTitle;
  }
  if (flowState.step === "choose-session") {
    return copy.chooseAccountTitle;
  }
  if (flowState.step === "choose-factor") {
    return copy.chooseMethodTitle;
  }
  if (flowState.step === "password") {
    return copy.passwordTitle;
  }
  if (flowState.step === "password-recovery") {
    return copy.recoveryTitle;
  }
  if (flowState.step === "help") {
    return copy.helpTitle;
  }
  if (
    flowState.step === "email-code" ||
    flowState.step === "client-trust-code"
  ) {
    return copy.emailCodeTitle;
  }
  if (flowState.step === "password-reset-code") {
    return copy.resetPasswordCodeTitle;
  }
  if (flowState.step === "new-password") {
    return copy.newPasswordTitle;
  }
  return copy.signInTitle;
}

export function signInFactorLabel(
  factor: AuthV2SignInFactor,
  copy: AuthV2SignInCopy,
): string {
  if (factor.kind === "password") {
    return copy.passwordMethod;
  }
  if (factor.kind === "password-reset") {
    return copy.passwordResetMethod;
  }
  if (factor.kind === "oauth") {
    return factor.strategy === "oauth_apple"
      ? copy.appleMethod
      : copy.googleMethod;
  }
  if (factor.kind === "passkey") {
    return copy.passkeyMethod;
  }
  return copy.emailCodeMethod(factor.safeIdentifier);
}
