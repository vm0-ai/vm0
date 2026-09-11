import { enUS } from "@clerk/localizations/en-US";

import type { AuthV2PasswordError } from "../signals/auth-v2/password-errors.ts";

const complexityKeys = [
  ["max_length", "maximumLength"],
  ["min_length", "minimumLength"],
  ["require_numbers", "requireNumbers"],
  ["require_lowercase", "requireLowercase"],
  ["require_uppercase", "requireUppercase"],
  ["require_special_char", "requireSpecialCharacter"],
] as const;

function translatedMessage(
  localized: Readonly<Record<string, unknown>> | undefined,
  english: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  for (const resource of [localized, english]) {
    const value = resource && Object.hasOwn(resource, key) && resource[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function clerkPasswordErrorMessage(
  localization: typeof enUS,
  error: AuthV2PasswordError,
): string | undefined {
  const localized = localization.unstable__errors;
  const english = enUS.unstable__errors;
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
    const template = translatedMessage(
      localized?.passwordComplexity,
      english?.passwordComplexity,
      key,
    );
    if (!template) {
      return undefined;
    }
    const message =
      rule === "min_length" || rule === "max_length"
        ? template.replaceAll("{{length}}", String(error.limits[rule]))
        : template;
    if (message.includes("{{")) {
      return undefined;
    }
    messages.push(message);
  }
  if (messages.length > 0) {
    const prefix = translatedMessage(
      localized?.passwordComplexity,
      english?.passwordComplexity,
      "sentencePrefix",
    );
    if (!prefix) {
      return undefined;
    }
    const requirements = new Intl.ListFormat(localization.locale, {
      style: "long",
      type: "conjunction",
    }).format(messages);
    const message = `${prefix} ${requirements}`;
    return message.endsWith(".") ? message : `${message}.`;
  }
  if (!error.strengthFailed) {
    return undefined;
  }
  const notEnough = translatedMessage(
    localized?.zxcvbn,
    english?.zxcvbn,
    "notEnough",
  );
  if (!notEnough) {
    return undefined;
  }
  const suggestions = error.suggestionCodes.flatMap((code) => {
    const message = translatedMessage(
      localized?.zxcvbn?.suggestions,
      english?.zxcvbn?.suggestions,
      code,
    );
    return message && !message.includes("{{") ? [message] : [];
  });
  return [notEnough, ...suggestions].join(" ");
}
