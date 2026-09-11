import { enUS } from "@clerk/localizations/en-US";

// Clerk's English resource leaves many API errors undefined and displays the
// provider's longMessage instead. Keep reviewed copy for those codes so custom
// sign-in never needs to render arbitrary provider details.
const englishApiErrors: Readonly<Record<string, string>> = {
  captcha_invalid: "Security verification failed. Please try again.",
  captcha_missing_token:
    "Security verification is missing. Please refresh the page and try again.",
  clerk_runtime_load_timeout:
    "Sign-in took too long to load. Please refresh the page and try again.",
  device_blocked:
    "Sign-in is blocked on this device. Please contact support for help.",
  external_account_not_found:
    "No account is linked to this sign-in method. Try another method or sign up.",
  form_identifier_invalid: "Enter a valid email address or username.",
  form_identifier_not_found:
    "We couldn't find an account with those details. Check them or sign up.",
  form_param_format_invalid: "The format is invalid. Please check your input.",
  form_param_format_invalid__email_address: "Enter a valid email address.",
  form_param_format_invalid__identifier:
    "Enter a valid email address or username.",
  form_param_nil: "This field is required.",
  form_param_type_invalid: "Please enter a valid value.",
  form_param_type_invalid__email_address: "Enter a valid email address.",
  form_param_value_invalid: "Please check the value you entered.",
  form_password_compromised__sign_in:
    "Your password may be compromised. Use another sign-in method, then reset your password.",
  form_password_incorrect: "Incorrect password. Please try again.",
  form_password_or_identifier_incorrect:
    "Incorrect email address, username, or password. Please try again.",
  form_password_size_in_bytes_exceeded:
    "Your password is too long. Please use a shorter password.",
  form_password_validation_failed: "Incorrect password. Please try again.",
  session_exists: "You are already signed in. Refresh the page to continue.",
  signup_rate_limit_exceeded:
    "Too many attempts. Please wait a moment before trying again.",
  strategy_for_user_invalid:
    "This sign-in method is unavailable for your account. Try another method.",
  too_many_requests:
    "Too many attempts. Please wait a moment before trying again.",
  user_deactivated:
    "Your account has been deactivated. Please contact support for help.",
  user_locked:
    "Your account is temporarily locked after too many failed attempts. Please try again later.",
};

function errorMessage(
  messages: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  if (!messages || !Object.hasOwn(messages, key)) {
    return undefined;
  }
  const message = messages[key];
  // Errors requiring interpolation metadata cannot be displayed as templates.
  return typeof message === "string" &&
    message.trim().length > 0 &&
    !message.includes("{{")
    ? message
    : undefined;
}

export function clerkSignInErrorMessage(
  localization: typeof enUS,
  {
    code,
    paramName,
    signingInWithPassword,
  }: {
    readonly code: string;
    readonly paramName?: string;
    readonly signingInWithPassword: boolean;
  },
): string | undefined {
  // Match @clerk/ui@1.26.0 SignInFactorOnePasswordCard and
  // useLocalizations().translateError: sign-in password variants, then
  // code__paramName, then code. Preserve the application's unknown-error copy.
  const localizationCode =
    signingInWithPassword &&
    (code === "form_password_pwned" || code === "form_password_compromised")
      ? `${code}__sign_in`
      : code;
  const keys = paramName
    ? [`${localizationCode}__${paramName}`, localizationCode]
    : [localizationCode];
  for (const key of keys) {
    const message =
      errorMessage(localization.unstable__errors, key) ??
      errorMessage(enUS.unstable__errors, key);
    if (message) {
      return message;
    }
  }
  for (const key of keys) {
    const message = errorMessage(englishApiErrors, key);
    if (message) {
      return message;
    }
  }
  return undefined;
}
