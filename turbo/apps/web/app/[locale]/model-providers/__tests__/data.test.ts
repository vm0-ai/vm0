import { describe, expect, it } from "vitest";
import { getSelectableProviderTypes } from "@vm0/api-contracts/contracts/model-providers";
import {
  getAllProviders,
  getOrderedProviders,
  getProvider,
  PROVIDER_SLUGS,
} from "../data";

describe("model-providers data", () => {
  it("exposes exactly the selectable providers from the contract", () => {
    expect(PROVIDER_SLUGS).toEqual(getSelectableProviderTypes());
  });

  it("returns view models for every selectable provider", () => {
    const providers = getAllProviders();
    expect(providers).toHaveLength(PROVIDER_SLUGS.length);
    for (const provider of providers) {
      expect(provider.contractLabel).toBeTruthy();
      expect(provider.displayName).toBeTruthy();
      expect(provider.content.tagline).toBeTruthy();
      expect(provider.content.metaDescription.length).toBeLessThanOrEqual(170);
      expect(provider.content.faqs.length).toBeGreaterThan(0);
      expect(provider.content.evaluation.length).toBeGreaterThan(0);
      expect(provider.content.strengths.length).toBeGreaterThan(0);
    }
  });

  it("getOrderedProviders surfaces every selectable provider exactly once", () => {
    const ordered = getOrderedProviders();
    expect(ordered).toHaveLength(PROVIDER_SLUGS.length);
    const slugs = new Set(
      ordered.map((p) => {
        return p.slug;
      }),
    );
    for (const slug of PROVIDER_SLUGS) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  it("getProvider returns null for unknown slugs and a view model for known slugs", () => {
    expect(getProvider("not-a-real-provider")).toBeNull();
    for (const slug of PROVIDER_SLUGS) {
      const provider = getProvider(slug);
      expect(provider).not.toBeNull();
      expect(provider?.slug).toBe(slug);
    }
  });
});
