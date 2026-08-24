import { enUS } from "@clerk/localizations";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type {
  AuthV2SignInError,
  AuthV2SignInFactor,
  AuthV2SignInState,
} from "../../../signals/auth-v2/sign-in-flow.ts";
import { resolveAuthBrandContext } from "../../../signals/auth.ts";
import { locale$ } from "../../../signals/locale.ts";
import { getClerkLocalization } from "../../auth/clerk-localization.ts";

const CLERK_APPLICATION_NAME = "{{applicationName}}";
const CLERK_IDENTIFIER = "{{identifier}}";
const CLERK_PROVIDER = "{{provider|titleize}}";

type ClerkLocalization = ReturnType<typeof getClerkLocalization>;

export interface AuthV2SignInCopy {
  readonly addAccount: string;
  readonly back: string;
  readonly chooseAccountSubtitle: string;
  readonly chooseAccountTitle: string;
  readonly chooseMethodSubtitle: string;
  readonly chooseMethodTitle: string;
  readonly codeLabel: string;
  readonly completeSubtitle: string;
  readonly completeTitle: string;
  readonly confirmPasswordLabel: string;
  readonly continue: string;
  readonly editIdentifier: string;
  readonly emailCodeMethod: string;
  readonly emailCodeSubtitle: string;
  readonly emailCodeTitle: string;
  readonly forgotPassword: string;
  readonly googleMethod: string;
  readonly identifierLabel: string;
  readonly legacySignIn: string;
  readonly loading: string;
  readonly newPasswordLabel: string;
  readonly newPasswordSubtitle: string;
  readonly newPasswordTitle: string;
  readonly noAccount: string;
  readonly noMethodsMessage: string;
  readonly noMethodsTitle: string;
  readonly passwordLabel: string;
  readonly passwordMethod: string;
  readonly passwordMismatch: string;
  readonly passwordResetMethod: string;
  readonly passwordSubtitle: string;
  readonly passwordTitle: string;
  readonly passkeyCancelled: string;
  readonly passkeyMethod: string;
  readonly passkeyUnavailable: string;
  readonly resendCode: string;
  readonly resetPassword: string;
  readonly resetPasswordCodeSubtitle: string;
  readonly resetPasswordCodeTitle: string;
  readonly signInTitle: string;
  readonly signUp: string;
  readonly startSubtitle: string;
  readonly unknownError: string;
  readonly useAnotherMethod: string;
  readonly verify: string;
}

function localizedString(value: unknown, fallback: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof fallback === "string" ? fallback : "";
}

function replaceClerkVariable(
  value: string,
  variable: string,
  replacement: string,
): string {
  return value.replaceAll(variable, replacement);
}

function localizedWithAppName(
  value: unknown,
  fallback: unknown,
  appName: string,
): string {
  return replaceClerkVariable(
    localizedString(value, fallback),
    CLERK_APPLICATION_NAME,
    appName,
  );
}

function formCopy(localization: ClerkLocalization) {
  return {
    back: localizedString(localization.backButton, enUS.backButton),
    codeLabel: localizedString(
      localization.signIn?.emailCode?.formTitle,
      enUS.signIn?.emailCode?.formTitle,
    ),
    confirmPasswordLabel: localizedString(
      localization.formFieldLabel__confirmPassword,
      enUS.formFieldLabel__confirmPassword,
    ),
    continue: localizedString(
      localization.formButtonPrimary,
      enUS.formButtonPrimary,
    ),
    editIdentifier: localizedString(
      localization.identityPreviewEditButton__identifier,
      enUS.identityPreviewEditButton__identifier,
    ),
    identifierLabel: localizedString(
      localization.formFieldLabel__emailAddress_username,
      enUS.formFieldLabel__emailAddress_username,
    ),
    passwordLabel: localizedString(
      localization.formFieldLabel__password,
      enUS.formFieldLabel__password,
    ),
    passwordMismatch: localizedString(
      localization.formFieldError__notMatchingPasswords,
      enUS.formFieldError__notMatchingPasswords,
    ),
    unknownError: localizedString(
      localization.unstable__errors?.action_blocked,
      enUS.unstable__errors?.action_blocked,
    ),
    useAnotherMethod: localizedString(
      localization.footerActionLink__useAnotherMethod,
      enUS.footerActionLink__useAnotherMethod,
    ),
    verify: localizedString(
      localization.formButtonPrimary__verify,
      enUS.formButtonPrimary__verify,
    ),
  };
}

function startCopy(localization: ClerkLocalization) {
  const start = localization.signIn?.start;
  const fallback = enUS.signIn?.start;
  return {
    noAccount: localizedString(start?.actionText, fallback?.actionText),
    signUp: localizedString(start?.actionLink, fallback?.actionLink),
    startSubtitle: localizedString(start?.subtitle, fallback?.subtitle),
  };
}

function methodCopy(localization: ClerkLocalization) {
  const methods = localization.signIn?.alternativeMethods;
  const fallback = enUS.signIn?.alternativeMethods;
  return {
    chooseMethodSubtitle: localizedString(
      methods?.subtitle,
      fallback?.subtitle,
    ),
    chooseMethodTitle: localizedString(methods?.title, fallback?.title),
    emailCodeMethod: localizedString(
      methods?.blockButton__emailCode,
      fallback?.blockButton__emailCode,
    ),
    passwordMethod: localizedString(
      methods?.blockButton__password,
      fallback?.blockButton__password,
    ),
    passkeyMethod: localizedString(
      methods?.blockButton__passkey,
      fallback?.blockButton__passkey,
    ),
    googleMethod: replaceClerkVariable(
      localizedString(
        localization.socialButtonsBlockButton,
        enUS.socialButtonsBlockButton,
      ),
      CLERK_PROVIDER,
      "Google",
    ),
  };
}

function accountCopy(localization: ClerkLocalization) {
  const accountSwitcher = localization.signIn?.accountSwitcher;
  const fallback = enUS.signIn?.accountSwitcher;
  return {
    addAccount: localizedString(
      accountSwitcher?.action__addAccount,
      fallback?.action__addAccount,
    ),
    chooseAccountSubtitle: localizedString(
      accountSwitcher?.subtitle,
      fallback?.subtitle,
    ),
    chooseAccountTitle: localizedString(
      accountSwitcher?.title,
      fallback?.title,
    ),
  };
}

function passkeyErrorCopy(localization: ClerkLocalization) {
  return {
    passkeyCancelled: localizedString(
      localization.unstable__errors?.passkey_retrieval_cancelled,
      enUS.unstable__errors?.passkey_retrieval_cancelled,
    ),
    passkeyUnavailable: localizedString(
      localization.unstable__errors?.passkey_not_supported,
      enUS.unstable__errors?.passkey_not_supported,
    ),
  };
}

function passwordCopy(localization: ClerkLocalization) {
  const password = localization.signIn?.password;
  const fallback = enUS.signIn?.password;
  return {
    forgotPassword: localizedString(
      localization.formFieldAction__forgotPassword,
      enUS.formFieldAction__forgotPassword,
    ),
    passwordSubtitle: localizedString(password?.subtitle, fallback?.subtitle),
    passwordTitle: localizedString(password?.title, fallback?.title),
  };
}

function emailCodeCopy(localization: ClerkLocalization, appName: string) {
  const emailCode = localization.signIn?.emailCode;
  const fallback = enUS.signIn?.emailCode;
  return {
    emailCodeSubtitle: localizedWithAppName(
      emailCode?.subtitle,
      fallback?.subtitle,
      appName,
    ),
    emailCodeTitle: localizedString(emailCode?.title, fallback?.title),
    resendCode: localizedString(
      emailCode?.resendButton,
      fallback?.resendButton,
    ),
  };
}

function resetPasswordCopy(localization: ClerkLocalization) {
  const reset = localization.signIn?.resetPassword;
  const fallback = enUS.signIn?.resetPassword;
  return {
    newPasswordLabel: localizedString(
      localization.formFieldLabel__newPassword,
      enUS.formFieldLabel__newPassword,
    ),
    newPasswordSubtitle: localizedString(
      reset?.requiredMessage,
      fallback?.requiredMessage,
    ),
    newPasswordTitle: localizedString(reset?.title, fallback?.title),
    resetPassword: localizedString(
      reset?.formButtonPrimary,
      fallback?.formButtonPrimary,
    ),
  };
}

function resetCodeCopy(localization: ClerkLocalization) {
  const forgot = localization.signIn?.forgotPassword;
  const fallback = enUS.signIn?.forgotPassword;
  return {
    passwordResetMethod: localizedString(
      localization.signIn?.forgotPasswordAlternativeMethods
        ?.blockButton__resetPassword,
      enUS.signIn?.forgotPasswordAlternativeMethods?.blockButton__resetPassword,
    ),
    resetPasswordCodeSubtitle: localizedString(
      forgot?.subtitle_email,
      fallback?.subtitle_email,
    ),
    resetPasswordCodeTitle: localizedString(forgot?.title, fallback?.title),
  };
}

function terminalCopy(localization: ClerkLocalization, appName: string) {
  const loading = localization.signIn?.emailLink?.loading;
  const fallbackLoading = enUS.signIn?.emailLink?.loading;
  const unavailable = localization.signIn?.noAvailableMethods;
  const fallbackUnavailable = enUS.signIn?.noAvailableMethods;
  return {
    completeSubtitle: localizedWithAppName(
      loading?.subtitle,
      fallbackLoading?.subtitle,
      appName,
    ),
    completeTitle: localizedString(loading?.title, fallbackLoading?.title),
    noMethodsMessage: localizedString(
      unavailable?.message,
      fallbackUnavailable?.message,
    ),
    noMethodsTitle: localizedString(
      unavailable?.title,
      fallbackUnavailable?.title,
    ),
  };
}

export function useAuthV2SignInCopy(): AuthV2SignInCopy {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  const authBrand = resolveAuthBrandContext();
  const localization = getClerkLocalization(authBrand.brandName, locale, t);
  const translatedCopy = {
    legacySignIn: t(($) => {
      return $.auth.v2.signIn.action;
    }),
    loading: t(($) => {
      return $.auth.loading;
    }),
    signInTitle: t(
      ($) => {
        return $.auth.v2.signIn.title;
      },
      { brandName: authBrand.brandName },
    ),
  };
  return {
    ...formCopy(localization),
    ...startCopy(localization),
    ...accountCopy(localization),
    ...methodCopy(localization),
    ...passwordCopy(localization),
    ...emailCodeCopy(localization, authBrand.brandName),
    ...resetPasswordCopy(localization),
    ...resetCodeCopy(localization),
    ...terminalCopy(localization, authBrand.brandName),
    ...passkeyErrorCopy(localization),
    ...translatedCopy,
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
    return error.message ?? copy.passkeyCancelled;
  }
  if (error.code === "passkey-unavailable") {
    return error.message ?? copy.passkeyUnavailable;
  }
  return error.message ?? copy.unknownError;
}

export function signInCardDescription(
  flowState: AuthV2SignInState,
  copy: AuthV2SignInCopy,
): string {
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
  if (flowState.step === "email-code") {
    return copy.emailCodeSubtitle;
  }
  if (flowState.step === "password-reset-code") {
    return copy.resetPasswordCodeSubtitle;
  }
  if (flowState.step === "new-password") {
    return copy.newPasswordSubtitle;
  }
  return copy.startSubtitle;
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
    return copy.googleMethod;
  }
  if (factor.kind === "passkey") {
    return copy.passkeyMethod;
  }
  return replaceClerkVariable(
    copy.emailCodeMethod,
    CLERK_IDENTIFIER,
    factor.safeIdentifier,
  );
}
