import { describe, expect, it } from "vitest";

import deDECommon from "../../../i18n/locales/de-DE/common.json";
import enUSCommon from "../../../i18n/locales/en-US/common.json";
import esESCommon from "../../../i18n/locales/es-ES/common.json";
import frFRCommon from "../../../i18n/locales/fr-FR/common.json";
import hiINCommon from "../../../i18n/locales/hi-IN/common.json";
import idIDCommon from "../../../i18n/locales/id-ID/common.json";
import itITCommon from "../../../i18n/locales/it-IT/common.json";
import jaJPCommon from "../../../i18n/locales/ja-JP/common.json";
import koKRCommon from "../../../i18n/locales/ko-KR/common.json";
import ptBRCommon from "../../../i18n/locales/pt-BR/common.json";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../../../i18n/resources.ts";

const commonResources = {
  "de-DE": deDECommon,
  "en-US": enUSCommon,
  "es-ES": esESCommon,
  "fr-FR": frFRCommon,
  "hi-IN": hiINCommon,
  "id-ID": idIDCommon,
  "it-IT": itITCommon,
  "ja-JP": jaJPCommon,
  "ko-KR": koKRCommon,
  "pt-BR": ptBRCommon,
} as const satisfies Record<SupportedLocale, Readonly<Record<string, unknown>>>;

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

const clerkLocalizationSources = import.meta.glob(
  "../../auth/clerk-localization.ts",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

const clerkProviderSources = import.meta.glob(
  "../../clerk/clerk-provider.tsx",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

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
    const expectedKeys = leafEntries(commonResources[DEFAULT_LOCALE].auth.v2)
      .map(([key]) => {
        return key;
      })
      .sort();

    for (const locale of SUPPORTED_LOCALES) {
      const entries = leafEntries(commonResources[locale].auth.v2);
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
      const copy = JSON.stringify(commonResources[locale].auth.v2);
      expect(copy).not.toContain("{{applicationName}}");
      expect(copy).not.toContain("{{provider");
      expect(copy).not.toContain("termsOfServiceLink");
      expect(copy).not.toContain("privacyPolicyLink");
    }
  });

  it("localizes critical Auth v2 recovery and CAPTCHA copy outside English", () => {
    expect(criticalLocalizedAuthV2Keys).not.toHaveLength(0);
    const englishEntries = new Map(
      leafEntries(commonResources[DEFAULT_LOCALE].auth.v2),
    );

    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) {
        continue;
      }
      const localizedEntries = new Map(
        leafEntries(commonResources[locale].auth.v2),
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
      const copy = commonResources[locale].auth.v2.signUp;
      expect(copy.legalPrivacyOnly).toMatch(/<privacy>.+<\/privacy>/);
      expect(copy.legalTermsOnly).toMatch(/<terms>.+<\/terms>/);
      expect(copy.legalTermsAndPrivacy).toMatch(/<terms>.+<\/terms>/);
      expect(copy.legalTermsAndPrivacy).toMatch(/<privacy>.+<\/privacy>/);
    }
  });

  it("keeps Clerk localization out of Auth v2 and in the shared provider", () => {
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

    const clerkLocalization = Object.values(clerkLocalizationSources).join(
      "\n",
    );
    expect(clerkLocalization).toContain("getClerkLocalization");
    expect(clerkLocalization).toContain("clerkLocalizationForLocale");

    const clerkProvider = Object.values(clerkProviderSources).join("\n");
    expect(clerkProvider).toContain('from "../auth/clerk-localization.ts"');
    expect(clerkProvider).toMatch(/localization:\s*getClerkLocalization\(/);
  });
});
