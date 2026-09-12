import type common from "./locales/en-US/common.json";
import type { AuthV2PasswordError } from "../signals/auth-v2/password-errors.ts";
import { clerkPasswordErrorMessage } from "./clerk-password-errors.ts";

function errorMessage(
  messages: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(messages, key) ? messages[key] : undefined;
}

export function clerkAuthErrorMessage(
  messages: typeof common.auth.v2.clerkErrors,
  locale: string,
  {
    code,
    paramName,
    passwordError,
    signingInWithPassword,
  }: {
    readonly code?: string;
    readonly paramName?: string;
    readonly passwordError?: AuthV2PasswordError;
    readonly signingInWithPassword: boolean;
  },
): string | undefined {
  // A rate-limited request must not be presented as a password validation error,
  // even if the response also contains password-related error codes.
  if (passwordError && code !== "too_many_requests") {
    return clerkPasswordErrorMessage(messages, locale, passwordError);
  }
  if (!code) {
    return undefined;
  }
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
  // Known codes use complete product translations. Clerk's own resources leave
  // many keys undefined or in English even for a non-English locale.
  for (const key of keys) {
    const message = errorMessage(messages.api, key);
    if (message) {
      return message;
    }
  }
  return undefined;
}
