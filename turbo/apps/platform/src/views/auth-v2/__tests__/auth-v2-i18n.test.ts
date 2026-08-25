import { describe, expect, it } from "vitest";

import { resources, SUPPORTED_LOCALES } from "../../../i18n/resources.ts";

const authV2ViewSources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const authV2SignalSources = import.meta.glob(
  "../../../signals/auth-v2/**/*.{ts,tsx}",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

const v1LocalizationSources = import.meta.glob(
  "../../auth/clerk-localization.ts",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

const v1ProviderSources = import.meta.glob("../../clerk/clerk-provider.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const criticalLocalizedAuthV2Keys: readonly string[] = [
  "signIn.editIdentifier",
  "signIn.unknownError",
  "signUp.unknownError",
  "signUp.captchaLoading",
  "signUp.captchaSubtitle",
  "signUp.captchaTitle",
  "signUp.editEmailAddress",
  "signUp.retry",
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function leafEntries(
  value: unknown,
  prefix = "",
): readonly (readonly [string, unknown])[] {
  if (!isRecord(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    return leafEntries(child, prefix ? `${prefix}.${key}` : key);
  });
}

describe("auth v2 platform localization ownership", () => {
  it("defines the complete Auth v2 key set for every supported locale", () => {
    const expectedKeys = leafEntries(resources["en-US"].common.auth.v2)
      .map(([key]) => {
        return key;
      })
      .sort();

    for (const locale of SUPPORTED_LOCALES) {
      const entries = leafEntries(resources[locale].common.auth.v2);
      expect(
        entries
          .map(([key]) => {
            return key;
          })
          .sort(),
      ).toStrictEqual(expectedKeys);
      for (const [, value] of entries) {
        expect(typeof value).toBe("string");
        expect(value).not.toBe("");
      }
    }
  });

  it("keeps Clerk template syntax out of platform-owned Auth v2 copy", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const copy = JSON.stringify(resources[locale].common.auth.v2);
      expect(copy).not.toContain("{{applicationName}}");
      expect(copy).not.toContain("{{provider");
      expect(copy).not.toContain("termsOfServiceLink");
      expect(copy).not.toContain("privacyPolicyLink");
    }
  });

  it("localizes critical Auth v2 recovery and CAPTCHA copy outside English", () => {
    expect(criticalLocalizedAuthV2Keys).not.toHaveLength(0);
    const englishEntries = new Map(
      leafEntries(resources["en-US"].common.auth.v2),
    );

    for (const locale of SUPPORTED_LOCALES) {
      if (locale === "en-US") {
        continue;
      }
      const localizedEntries = new Map(
        leafEntries(resources[locale].common.auth.v2),
      );
      for (const key of criticalLocalizedAuthV2Keys) {
        expect([locale, key, localizedEntries.get(key)]).not.toStrictEqual([
          locale,
          key,
          englishEntries.get(key),
        ]);
      }
    }
  });

  it("preserves every localized legal-link token contract", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const copy = resources[locale].common.auth.v2.signUp;
      expect(copy.legalPrivacyOnly).toMatch(/<privacy>.+<\/privacy>/);
      expect(copy.legalTermsOnly).toMatch(/<terms>.+<\/terms>/);
      expect(copy.legalTermsAndPrivacy).toMatch(/<terms>.+<\/terms>/);
      expect(copy.legalTermsAndPrivacy).toMatch(/<privacy>.+<\/privacy>/);
    }
  });

  it("uses no Clerk localization lookup in Auth v2 while preserving v1", () => {
    const sources = Object.entries({
      ...authV2SignalSources,
      ...authV2ViewSources,
    }).filter(([file]) => {
      return !file.includes("/__tests__/");
    });
    for (const [, source] of sources) {
      expect(source).not.toContain("@clerk/localizations");
      expect(source).not.toContain("getClerkLocalization");
    }

    const v1Localization = Object.values(v1LocalizationSources).join("\n");
    expect(v1Localization).toContain("@clerk/localizations");
    expect(v1Localization).toContain("getClerkLocalization");

    const v1Provider = Object.values(v1ProviderSources).join("\n");
    expect(v1Provider).toContain('from "../auth/clerk-localization.ts"');
    expect(v1Provider).toMatch(/localization:\s*getClerkLocalization\(/);
  });
});
