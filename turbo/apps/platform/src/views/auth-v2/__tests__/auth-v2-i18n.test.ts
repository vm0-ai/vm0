import { act, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockSignUpConfiguration } from "../../../__tests__/mock-auth.ts";
import { changeI18nLanguage } from "../../../i18n/index.ts";
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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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

function linkNamed(name: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Expected link named ${name}`);
  }
  return link;
}

test("Every supported language provides complete authentication copy", async () => {
  const expectedKeys = leafEntries(commonResources[DEFAULT_LOCALE].auth.v2)
    .map(([key]) => {
      return key;
    })
    .sort();
  const englishEntries = new Map(
    leafEntries(commonResources[DEFAULT_LOCALE].auth.v2),
  );

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

    const copy = JSON.stringify(commonResources[locale].auth.v2);
    expect(copy).not.toContain("{{applicationName}}");
    expect(copy).not.toContain("{{provider");
  }

  for (const locale of SUPPORTED_LOCALES.filter((candidate) => {
    return candidate !== DEFAULT_LOCALE;
  })) {
    const localizedEntries = new Map(
      leafEntries(commonResources[locale].auth.v2),
    );
    for (const key of criticalLocalizedAuthV2Keys) {
      expect(localizedEntries.get(key)).not.toBe(englishEntries.get(key));
    }
  }

  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: "/sign-up",
  });
  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  for (const locale of SUPPORTED_LOCALES) {
    await act(async () => {
      document.documentElement.lang = locale;
      await changeI18nLanguage(locale, context.signal);
    });
    expect(document.body).not.toHaveTextContent(/\{\{(?:brandName|provider)/);
  }
});

test("Legal consent remains understandable and clickable in every supported language", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const copy = commonResources[locale].auth.v2.signUp;
    expect(copy.legalPrivacyOnly).toMatch(/<privacy>.+<\/privacy>/);
    expect(copy.legalTermsOnly).toMatch(/<terms>.+<\/terms>/);
    expect(copy.legalTermsAndPrivacy).toMatch(/<terms>.+<\/terms>/);
    expect(copy.legalTermsAndPrivacy).toMatch(/<privacy>.+<\/privacy>/);
  }

  mockSignUpConfiguration({
    legalConsentEnabled: true,
    privacyPolicyUrl: "https://vm0.ai/legal/privacy",
    termsUrl: "https://vm0.ai/legal/terms",
  });
  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: "/sign-up",
  });

  await expect(screen.findByRole("checkbox")).resolves.toBeVisible();
  expect(linkNamed("Terms of Service")).toHaveAttribute(
    "href",
    "https://vm0.ai/legal/terms",
  );
  expect(linkNamed("Privacy Policy")).toHaveAttribute(
    "href",
    "https://vm0.ai/legal/privacy",
  );
});
