import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";

import { MODELS, isReasoningModel } from "../data";

const MODEL_CONTENT_LOCALES = ["en", "de", "es", "ja"] as const;
const REMOVED_MODEL_CONTENT_TERMS = [
  "Claude Haiku 4.5",
  "Haiku 4.5",
  "Haiku",
  "DeepSeek V4 Flash",
  "V4 Flash",
  "lower-cost V4 sibling",
  "Both V4 models",
  "MiniMax M2.7",
  "M2.7",
] as const;

function readModelContent(locale: (typeof MODEL_CONTENT_LOCALES)[number]) {
  const json = readFileSync(
    new URL(`../../../../messages/${locale}.json`, import.meta.url),
    "utf8",
  );
  const messages = JSON.parse(json) as {
    readonly models?: {
      readonly content?: unknown;
    };
  };
  return JSON.stringify(messages.models?.content ?? {});
}

describe("models page data", () => {
  it("has unique slugs and modelIds", () => {
    const slugs = MODELS.map((m) => {
      return m.slug;
    });
    const modelIds = MODELS.map((m) => {
      return m.modelId;
    });
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it("documents only VM0-managed reasoning models", () => {
    const reasoningIds = MODELS.filter(isReasoningModel).map((m) => {
      return m.modelId;
    });
    const vm0ModelIds = new Set(Object.keys(VM0_MODEL_TO_PROVIDER));
    expect(
      reasoningIds.every((modelId) => {
        return vm0ModelIds.has(modelId);
      }),
    ).toBe(true);
  });

  it("documents MiniMax M3 and omits removed backend models", () => {
    const reasoningIds = MODELS.filter(isReasoningModel).map((m) => {
      return m.modelId;
    });
    expect(reasoningIds).toContain("MiniMax-M3");
    expect(reasoningIds).not.toContain("claude-haiku-4-5");
    expect(reasoningIds).not.toContain("deepseek-v4-flash");
    expect(reasoningIds).not.toContain("MiniMax-M2.7");
  });

  it("links only documented model alternatives", () => {
    const slugs = new Set(
      MODELS.map((m) => {
        return m.slug;
      }),
    );
    const linkedSlugs = MODELS.flatMap((m) => {
      return m.alternativeSlugs;
    });
    expect(
      linkedSlugs.every((slug) => {
        return slugs.has(slug);
      }),
    ).toBe(true);
  });

  it("omits removed model names from localized model content", () => {
    for (const locale of MODEL_CONTENT_LOCALES) {
      const content = readModelContent(locale);
      for (const term of REMOVED_MODEL_CONTENT_TERMS) {
        expect(content).not.toContain(term);
      }
    }
  });
});
