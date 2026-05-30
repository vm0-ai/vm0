import { describe, expect, it } from "vitest";

import {
  PRESENTATION_ATTRIBUTION_PARAM,
  PRESENTATION_ATTRIBUTION_VALUE,
  buildPresentationRemixHref,
  type PresentationItem,
} from "../data";

const item: PresentationItem = {
  slug: "test-deck",
  title: "Test deck",
  prompt: "/gen presentation",
  embedUrl: "https://example.vm0.io",
  previewImage: "https://example.com/preview.png",
};

describe("presentation remix links", () => {
  it("marks presentation try-it links with source attribution", () => {
    const href = buildPresentationRemixHref(item, "https://app.vm0.ai");
    const url = new URL(href);

    expect(url.origin).toBe("https://app.vm0.ai");
    expect(url.pathname).toBe("/onboarding");
    expect(url.searchParams.get("prompt")).toBe(item.prompt);
    expect(url.searchParams.get("showcase")).toBe(item.embedUrl);
    expect(url.searchParams.get(PRESENTATION_ATTRIBUTION_PARAM)).toBe(
      PRESENTATION_ATTRIBUTION_VALUE,
    );
  });

  it("carries paid search attribution to the app", () => {
    const href = buildPresentationRemixHref(
      item,
      "https://app.vm0.ai",
      "?gclid=test-click&utm_source=google&utm_medium=cpc&utm_campaign=presentation_search_en&utm_content=hero&unused=value",
    );
    const params = new URL(href).searchParams;

    expect(params.get("gclid")).toBe("test-click");
    expect(params.get("utm_source")).toBe("google");
    expect(params.get("utm_medium")).toBe("cpc");
    expect(params.get("utm_campaign")).toBe("presentation_search_en");
    expect(params.get("utm_content")).toBe("hero");
    expect(params.get("unused")).toBeNull();
  });
});
