import { describe, expect, it } from "vitest";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import { USE_CASES, buildPromptHref } from "../../app/[locale]/use-cases/data";
import { locales, type Locale } from "../../i18n";
import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import jaMessages from "../../messages/ja.json";

describe("use cases data", () => {
  it("every connector id maps to a real CONNECTOR_TYPES key", () => {
    // "vm0" is used for marketing display only and is not a platform connector
    const KNOWN_DISPLAY_ONLY = new Set(["vm0"]);
    const invalid: string[] = [];
    for (const uc of USE_CASES) {
      for (const c of uc.connectors) {
        if (!(c.id in CONNECTOR_TYPES) && !KNOWN_DISPLAY_ONLY.has(c.id)) {
          invalid.push(`${uc.slug} → ${c.id}`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });
});

type MessagesShape = {
  useCases: {
    content: Record<string, unknown>;
    [key: string]: unknown;
  };
};

const SHARED_HEADING_KEYS = [
  "whatZeroDelivers",
  "whatTheProblemIs",
  "howZeroFixesIt",
  "stepConnectYourTools",
  "stepAskZero",
  "stepTakeItFurther",
  "tipsForBetterResults",
  "connectLabel",
  "tryIt",
];

const messagesByLocale: Record<Locale, MessagesShape> = {
  en: enMessages,
  de: deMessages,
  es: esMessages,
  ja: jaMessages,
};

// Guards the exact shape the use-case page and client call `.map`/`t()` on at
// runtime. A slug added to USE_CASES without matching translations in every
// locale crashed SSR in production (issue #10059, Sentry WEB-2F) — this test
// turns that class of content drift into a red CI check.
describe("use cases translation coverage", () => {
  it("every locale has shared section heading keys", () => {
    const problems: string[] = [];
    for (const locale of locales) {
      const uc = messagesByLocale[locale].useCases;
      for (const key of SHARED_HEADING_KEYS) {
        const value = (uc as Record<string, unknown>)[key];
        if (typeof value !== "string" || value.length === 0) {
          problems.push(`${locale} :: shared key ${key} missing or empty`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every (slug, locale) has the runtime-required translation shape", () => {
    const problems: string[] = [];
    const STRING_KEYS = ["title", "description", "scenario", "timeSaved"];
    for (const locale of locales) {
      const content = messagesByLocale[locale].useCases.content;

      for (const uc of USE_CASES) {
        const prefix = `${locale} :: ${uc.slug}`;
        const entry = content[uc.slug];

        if (!entry || typeof entry !== "object") {
          problems.push(`${prefix} :: missing content entry`);
          continue;
        }
        const e = entry as Record<string, unknown>;

        for (const key of STRING_KEYS) {
          const value = e[key];
          if (typeof value !== "string" || value.length === 0) {
            problems.push(
              `${prefix} :: ${key} is not a non-empty string (${typeof value})`,
            );
          }
        }

        const arrayChecks: Array<readonly [string, unknown, number]> = [
          ["steps", e.steps, uc.stepCount],
          ["nextActions", e.nextActions, uc.nextActionCount],
          ["tips", e.tips, uc.tipCount],
          ["promptVariants", e.promptVariants, uc.promptVariantCount],
          ["integrations", e.integrations, uc.integrationCount],
          ["slackPreview", e.slackPreview, uc.slackPreviewCount],
        ];
        for (const [key, value, expected] of arrayChecks) {
          if (!Array.isArray(value)) {
            problems.push(
              `${prefix} :: ${key} is not an array (${typeof value})`,
            );
          } else if (value.length !== expected) {
            problems.push(
              `${prefix} :: ${key} length ${value.length} != expected ${expected}`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

describe("buildPromptHref", () => {
  const connectors = USE_CASES[0]!.connectors;

  it("strips @Zero prefix from the prompt", () => {
    const href = buildPromptHref(
      "@Zero top 3 Sentry errors in the last 24h",
      connectors,
      "https://app.example.com",
    );
    const url = new URL(href);
    expect(url.searchParams.get("prompt")).toBe(
      "top 3 Sentry errors in the last 24h",
    );
  });

  it("passes through prompts without @Zero prefix unchanged", () => {
    const href = buildPromptHref(
      "show me recent errors",
      connectors,
      "https://app.example.com",
    );
    const url = new URL(href);
    expect(url.searchParams.get("prompt")).toBe("show me recent errors");
  });

  it("percent-encodes special characters", () => {
    const href = buildPromptHref(
      "hello world & friends",
      connectors,
      "https://app.example.com",
    );
    expect(href).toContain("prompt=hello+world+%26+friends");
  });

  it("omits empty params", () => {
    expect(buildPromptHref("", [], "https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });
});
