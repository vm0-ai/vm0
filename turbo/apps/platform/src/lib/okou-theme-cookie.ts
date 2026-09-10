import type { ThemePreference } from "@okouai/api-contracts/contracts/user-preferences";

const OKOU_THEME_COOKIE_VERSION = "v1";

export function decodeOkouThemePreference(
  value: string | null,
): ThemePreference | null {
  if (!value?.startsWith(`${OKOU_THEME_COOKIE_VERSION}.`)) {
    return null;
  }

  const preference = value.slice(OKOU_THEME_COOKIE_VERSION.length + 1);
  return preference === "light" ||
    preference === "dark" ||
    preference === "system"
    ? preference
    : null;
}

export function encodeOkouThemePreference(preference: ThemePreference): string {
  return `${OKOU_THEME_COOKIE_VERSION}.${preference}`;
}
