import type common from "./locales/en-US/common.json";

import type { AuthV2PasswordError } from "../signals/auth-v2/password-errors.ts";

const complexityKeys = [
  ["max_length", "maximumLength"],
  ["min_length", "minimumLength"],
  ["require_numbers", "requireNumbers"],
  ["require_lowercase", "requireLowercase"],
  ["require_uppercase", "requireUppercase"],
  ["require_special_char", "requireSpecialCharacter"],
] as const;

export function clerkPasswordErrorMessage(
  copy: typeof common.auth.v2.clerkErrors,
  locale: string,
  error: AuthV2PasswordError,
): string | undefined {
  const messages: string[] = [];
  // Match Clerk's usePasswordComplexity: minimum length is shown on its own,
  // before other failed rules. Use the configured limits, not the English
  // API translation's hard-coded eight-character minimum.
  for (const [rule, key] of complexityKeys) {
    if (
      !error.complexity[rule] ||
      (error.complexity.min_length && rule !== "min_length")
    ) {
      continue;
    }
    const template = copy.passwordComplexity[key];
    const message =
      rule === "min_length" || rule === "max_length"
        ? template.replaceAll("{{length}}", String(error.limits[rule]))
        : template;
    messages.push(message);
  }
  if (messages.length > 0) {
    const requirements = new Intl.ListFormat(locale, {
      style: "long",
      type: "conjunction",
    }).format(messages);
    const message = `${copy.passwordComplexity.sentencePrefix} ${requirements}`;
    return message.endsWith(".") ? message : `${message}.`;
  }
  if (!error.strengthFailed) {
    return undefined;
  }
  const translatedSuggestions: Readonly<Record<string, string>> =
    copy.zxcvbn.suggestions;
  const suggestions = error.suggestionCodes.flatMap((code) => {
    return Object.hasOwn(translatedSuggestions, code)
      ? [translatedSuggestions[code]]
      : [];
  });
  return [copy.zxcvbn.notEnough, ...suggestions].join(" ");
}
