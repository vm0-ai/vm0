import { enUS } from "@clerk/localizations/en-US";
import type { AuthV2PasswordError } from "../signals/auth-v2/password-errors.ts";
import { clerkPasswordErrorMessage } from "./clerk-password-errors.ts";

// Clerk's English resource leaves many API errors undefined and displays the
// provider's longMessage instead. Keep reviewed copy for those codes so custom
// authentication never needs to render arbitrary provider details.
const englishApiErrors: Readonly<Record<string, string>> = {
  already_a_member_in_organization:
    "You are already a member of this organization.",
  authentication_invalid:
    "Your sign-in session is no longer valid. Please sign in again.",
  captcha_invalid: "Security verification failed. Please try again.",
  captcha_missing_token:
    "Security verification is missing. Please refresh the page and try again.",
  captcha_not_enabled:
    "Security verification is unavailable. Please contact support for help.",
  clerk_offline: "You appear to be offline. Reconnect and try again.",
  clerk_runtime_load_timeout:
    "Sign-in took too long to load. Please refresh the page and try again.",
  device_blocked:
    "Sign-in is blocked on this device. Please contact support for help.",
  external_account_not_found:
    "No account is linked to this sign-in method. Try another method or sign up.",
  external_account_exists:
    "This account is already linked. Sign in using your existing account.",
  factor_not_found:
    "This verification method is no longer available. Choose another method or restart sign-in.",
  form_code_incorrect: "Incorrect verification code. Please try again.",
  form_email_address_blocked:
    "This email address cannot be used. Please try a different email address.",
  form_identifier_exists:
    "An account with these details already exists. Please sign in instead.",
  form_identifier_exists__email_address:
    "An account with this email address already exists. Please sign in instead.",
  form_identifier_exists__phone_number:
    "An account with this phone number already exists. Please sign in instead.",
  form_identifier_exists__username:
    "This username is already taken. Please choose another one.",
  form_identifier_invalid: "Enter a valid email address or username.",
  form_identifier_not_found:
    "We couldn't find an account with those details. Check them or sign up.",
  form_param_format_invalid: "The format is invalid. Please check your input.",
  form_param_format_invalid__email_address: "Enter a valid email address.",
  form_param_format_invalid__identifier:
    "Enter a valid email address or username.",
  form_param_format_invalid__phone_number:
    "Enter a valid phone number, including the country code.",
  form_param_max_length_exceeded:
    "This value is too long. Please shorten it and try again.",
  form_param_max_length_exceeded__first_name:
    "Your first name is too long. Please shorten it and try again.",
  form_param_max_length_exceeded__last_name:
    "Your last name is too long. Please shorten it and try again.",
  form_param_max_length_exceeded__name:
    "This name is too long. Please shorten it and try again.",
  form_param_nil: "This field is required.",
  form_param_type_invalid: "Please enter a valid value.",
  form_param_type_invalid__email_address: "Enter a valid email address.",
  form_param_type_invalid__phone_number:
    "Enter a valid phone number, including the country code.",
  form_param_value_invalid: "Please check the value you entered.",
  form_password_compromised__sign_in:
    "Your password may be compromised. Use another sign-in method, then reset your password.",
  form_password_incorrect: "Incorrect password. Please try again.",
  form_password_or_identifier_incorrect:
    "Incorrect email address, username, or password. Please try again.",
  form_password_size_in_bytes_exceeded:
    "Your password is too long. Please use a shorter password.",
  form_password_validation_failed: "Incorrect password. Please try again.",
  form_username_invalid_character:
    "Your username contains unsupported characters. Please choose another one.",
  invitation_account_not_exists:
    "Create an account using the invited email address to accept this invitation.",
  missing_expired_token:
    "Your sign-in session could not be renewed. Please sign in again.",
  missing_public_key_options:
    "Couldn't start passkey verification. Please try again or choose another sign-in method.",
  network_error:
    "Unable to connect. Check your internet connection and try again.",
  not_allowed_to_sign_up:
    "Sign-up is not allowed for this account. Please contact support for help.",
  not_allowed_access:
    "Access is not allowed for this account. Please contact support for help.",
  oauth_email_domain_reserved_by_saml:
    "Your organization requires single sign-on. Use your work email to continue.",
  saml_user_attribute_missing:
    "Your identity provider did not provide the required account details. Please contact your organization administrator.",
  enterprise_sso_user_attribute_missing:
    "Your identity provider did not provide the required account details. Please contact your organization administrator.",
  saml_email_address_domain_mismatch:
    "This account's email domain does not match your organization's single sign-on configuration. Use the correct work account.",
  enterprise_sso_email_address_domain_mismatch:
    "This account's email domain does not match your organization's single sign-on configuration. Use the correct work account.",
  enterprise_sso_hosted_domain_mismatch:
    "This account does not belong to the required organization. Use the correct work account.",
  organization_membership_quota_exceeded_for_sso:
    "The organization membership limit has been reached. Please contact your organization administrator.",
  passkey_invalid_rpID_or_domain:
    "Passkeys cannot be used on this website. Try another sign-in method.",
  passkey_retrieval_failed:
    "Passkey verification failed. Please try again or choose another sign-in method.",
  phone_number_exists:
    "This phone number is already in use. Please use another number.",
  protect_check_aborted:
    "Security verification was interrupted. Please try again.",
  protect_check_already_resolved:
    "Security verification has already completed. Please refresh to continue.",
  requires_captcha: "Complete the security verification and try again.",
  session_exists: "You are already signed in. Refresh the page to continue.",
  sign_up_mode_restricted:
    "An invitation is required to create an account. Please use your invitation link.",
  sign_up_restricted_waitlist:
    "Sign-up is currently limited to approved waitlist members. Please use your invitation when it arrives.",
  signup_rate_limit_exceeded:
    "Too many attempts. Please wait a moment before trying again.",
  strategy_for_user_invalid:
    "This sign-in method is unavailable for your account. Try another method.",
  too_many_requests:
    "Too many attempts. Please wait a moment before trying again.",
  user_deactivated:
    "Your account has been deactivated. Please contact support for help.",
  user_banned:
    "Your account has been suspended. Please contact support for help.",
  user_locked:
    "Your account is temporarily locked after too many failed attempts. Please try again later.",
  verification_expired:
    "This verification has expired. Request a new code and try again.",
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

export function clerkAuthErrorMessage(
  localization: typeof enUS,
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
    return clerkPasswordErrorMessage(localization, passwordError);
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
