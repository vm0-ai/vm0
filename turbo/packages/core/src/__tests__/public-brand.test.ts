import { describe, expect, it } from "vitest";

import {
  apiUrlForPublicBrand,
  appUrlForPublicBrand,
  publicBrandPresentation,
} from "../public-brand";

describe("public brand presentation", () => {
  it("maps VM0 and Okou to their public product and assistant names", () => {
    expect(publicBrandPresentation("vm0")).toEqual({
      assistantName: "Zero",
      brandName: "VM0",
    });
    expect(publicBrandPresentation("okou")).toEqual({
      assistantName: "Okou",
      brandName: "Okou",
    });
  });

  it("switches only the exact production app and API hosts", () => {
    expect(appUrlForPublicBrand("https://app.vm0.ai/", "okou")).toBe(
      "https://app.okou.ai",
    );
    expect(appUrlForPublicBrand("https://app.okou.ai", "vm0")).toBe(
      "https://app.vm0.ai",
    );
    expect(apiUrlForPublicBrand("https://api.vm0.ai/", "okou")).toBe(
      "https://api.okou.ai",
    );
    expect(apiUrlForPublicBrand("https://api.okou.ai", "vm0")).toBe(
      "https://api.vm0.ai",
    );
  });

  it("preserves preview and local origins", () => {
    expect(appUrlForPublicBrand("https://pr-27101-app.omby.ai/", "vm0")).toBe(
      "https://pr-27101-app.omby.ai",
    );
    expect(apiUrlForPublicBrand("http://localhost:3001/", "okou")).toBe(
      "http://localhost:3001",
    );
  });
});
