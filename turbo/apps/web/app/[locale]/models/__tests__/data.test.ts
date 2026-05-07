import { describe, expect, it } from "vitest";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";

import { locales, type Locale } from "../../../../i18n";
import deMessages from "../../../../messages/de.json";
import enMessages from "../../../../messages/en.json";
import esMessages from "../../../../messages/es.json";
import jaMessages from "../../../../messages/ja.json";
import { MODELS } from "../data";

type MessagesShape = {
  models: {
    content: Record<string, unknown>;
  };
};

const messagesByLocale: Record<Locale, MessagesShape> = {
  en: enMessages,
  de: deMessages,
  es: esMessages,
  ja: jaMessages,
};

describe("models page data", () => {
  it("covers every VM0 managed model", () => {
    const modelIds = MODELS.map((model) => {
      return model.modelId;
    });
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect([...modelIds].sort()).toStrictEqual(
      Object.keys(VM0_MODEL_TO_PROVIDER).sort(),
    );
  });

  it("has runtime-required translation content for every model locale", () => {
    const problems: string[] = [];
    const stringKeys = [
      "name",
      "pageTitle",
      "tagline",
      "cardIntro",
      "metaTitle",
      "metaDescription",
      "summary",
      "releaseDate",
      "familyPosition",
      "architecture",
      "verdict",
      "routingNotes",
      "vm0Notes",
    ];
    const arrayKeys = [
      "background",
      "specs",
      "benchmarks",
      "performance",
      "bestForExamples",
      "faqs",
      "comparisons",
      "alternatives",
    ];

    for (const locale of locales) {
      const content = messagesByLocale[locale].models.content;
      for (const model of MODELS) {
        const prefix = `${locale} :: ${model.slug}`;
        const entry = content[model.slug];
        if (!entry || typeof entry !== "object") {
          problems.push(`${prefix} :: missing content entry`);
          continue;
        }
        const e = entry as Record<string, unknown>;
        for (const key of stringKeys) {
          if (typeof e[key] !== "string") {
            problems.push(`${prefix} :: ${key} is not a string`);
          }
        }
        for (const key of arrayKeys) {
          if (!Array.isArray(e[key])) {
            problems.push(`${prefix} :: ${key} is not an array`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
