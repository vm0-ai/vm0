import { describe, expect, it, vi } from "vitest";

import { reloadEnv } from "../../../../src/env";
import { buildVideoRemixHref, type VideoItem } from "../data";

const item: VideoItem = {
  id: "video-template:test",
  slug: "test-video",
  title: "Test video",
  description: "Test video description",
  prompt: "/gen video",
  previewImage: "https://example.com/preview.jpg",
  cardPreviewImage: "https://example.com/card.jpg",
  previewVideo: "https://example.com/preview.mp4",
  previewWebm: "https://example.com/preview.webm",
  sourcePath: "video-template/test",
};

describe("video remix links", () => {
  it("marks video try-it links with source attribution", () => {
    const href = buildVideoRemixHref(item, "https://app.vm0.ai");
    const url = new URL(href);

    expect(url.origin).toBe("https://so.vm0.ai");
    expect(url.pathname).toBe("/onboarding/2afcf6");
    expect(url.searchParams.get("prompt")).toBe(item.prompt);
    expect(url.searchParams.get("showcase")).toBe(item.previewVideo);
    expect(url.searchParams.get("vm0_source")).toBe("video");
  });

  it("uses the configured paid onboarding origin", () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://staging-so.vm6.ai/");
    reloadEnv();

    const href = buildVideoRemixHref(item, "https://app.vm0.ai");

    expect(new URL(href).origin).toBe("https://staging-so.vm6.ai");
  });

  it("carries paid search attribution to onboarding", () => {
    const href = buildVideoRemixHref(
      item,
      "https://app.vm0.ai",
      "?gclid=test-click&utm_source=google&utm_medium=cpc&utm_campaign=video_search_en&utm_content=hero&vm0_experiment=video_lp&vm0_variant=a&unused=value",
    );
    const params = new URL(href).searchParams;

    expect(params.get("gclid")).toBe("test-click");
    expect(params.get("utm_source")).toBe("google");
    expect(params.get("utm_medium")).toBe("cpc");
    expect(params.get("utm_campaign")).toBe("video_search_en");
    expect(params.get("utm_content")).toBe("hero");
    expect(params.get("vm0_experiment")).toBe("video_lp");
    expect(params.get("vm0_variant")).toBe("a");
    expect(params.get("unused")).toBeNull();
  });
});
