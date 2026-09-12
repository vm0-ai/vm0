import type {
  PasswordSettingsData,
  PasswordValidation,
} from "@clerk/react/types";
import { computed } from "ccstate";

import { clerk$ } from "../auth.ts";
import { isRecord, stringProperty } from "../utils.ts";

type PasswordComplexity = NonNullable<PasswordValidation["complexity"]>;
type PasswordLimits = Pick<PasswordSettingsData, "min_length" | "max_length">;

export interface AuthV2PasswordError {
  readonly complexity: PasswordComplexity;
  readonly limits: PasswordLimits;
  readonly strengthFailed: boolean;
  readonly suggestionCodes: readonly string[];
}

export const clerkPasswordSettings$ = computed(async (get) => {
  const clerk = await get(clerk$);
  const environment = clerk.__internal_environment;
  if (!environment) {
    throw new Error(
      "Loaded Clerk instance did not provide environment configuration",
    );
  }
  return environment.userSettings.passwordSettings;
});

export function passwordValidationError(
  validation: PasswordValidation,
  limits: PasswordLimits,
): AuthV2PasswordError | null {
  const complexity = validation.complexity ?? {};
  const strengthFailed = validation.strength?.state === "fail";
  if (!Object.values(complexity).some(Boolean) && !strengthFailed) {
    return null;
  }
  const suggestionPrefix = "unstable__errors.zxcvbn.suggestions.";
  // Keep only rule flags and translation codes. The SDK strength result also
  // contains the password and must never be retained as error metadata.
  return {
    complexity,
    limits,
    strengthFailed,
    suggestionCodes:
      validation.strength?.state === "fail"
        ? validation.strength.keys
            .filter((key) => {
              return key.startsWith(suggestionPrefix);
            })
            .map((key) => {
              return key.slice(suggestionPrefix.length);
            })
        : [],
  };
}

// @clerk/ui@1.26.0 utils/passwordUtils.ts maps these API codes to the same
// requirements as client-side password validation.
const complexityErrorCodes: Readonly<Record<string, keyof PasswordComplexity>> =
  {
    form_password_length_too_long: "max_length",
    form_password_length_too_short: "min_length",
    form_password_no_uppercase: "require_uppercase",
    form_password_no_lowercase: "require_lowercase",
    form_password_no_number: "require_numbers",
    form_password_no_special_char: "require_special_char",
  };

export function clerkPasswordError(
  error: unknown,
  limits: PasswordLimits,
): AuthV2PasswordError | undefined {
  if (!isRecord(error) || !Array.isArray(error.errors)) {
    return undefined;
  }
  const errors = error.errors.filter(isRecord);
  const firstError = errors[0];
  const code = firstError && stringProperty(firstError, "code");
  const strengthFailed = code === "form_password_not_strong_enough";
  if (
    !code ||
    (!strengthFailed && !Object.hasOwn(complexityErrorCodes, code))
  ) {
    return undefined;
  }
  const complexity: PasswordComplexity = {};
  for (const apiError of errors) {
    const apiCode = stringProperty(apiError, "code");
    if (
      !strengthFailed &&
      apiCode &&
      Object.hasOwn(complexityErrorCodes, apiCode)
    ) {
      const rule = complexityErrorCodes[apiCode];
      if (rule) {
        complexity[rule] = true;
      }
    }
  }
  const meta = firstError?.meta;
  const strength = isRecord(meta) ? meta.zxcvbn : undefined;
  const suggestions = isRecord(strength) ? strength.suggestions : undefined;
  return {
    complexity,
    limits,
    strengthFailed,
    suggestionCodes: Array.isArray(suggestions)
      ? suggestions.filter(isRecord).flatMap((suggestion) => {
          const suggestionCode = stringProperty(suggestion, "code");
          return suggestionCode ? [suggestionCode] : [];
        })
      : [],
  };
}
