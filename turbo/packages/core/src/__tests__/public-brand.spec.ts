import { describe, expect, it } from "vitest";

import { staticUrlForPublicBrand } from "../public-brand";

describe("staticUrlForPublicBrand", () => {
  it("projects the shared production object path onto the requested brand", () => {
    expect(
      staticUrlForPublicBrand(
        "https://static.vm0.io/platform/icon.svg?version=1#logo",
        "okou",
      ),
    ).toBe("https://static.okou.io/platform/icon.svg?version=1#logo");
    expect(
      staticUrlForPublicBrand(
        "https://static.okou.io/platform/icon.svg?version=1#logo",
        "vm0",
      ),
    ).toBe("https://static.vm0.io/platform/icon.svg?version=1#logo");
  });

  it("leaves preview and custom static origins unchanged", () => {
    expect(
      staticUrlForPublicBrand(
        "https://static.vm7.io/platform/icon.svg",
        "okou",
      ),
    ).toBe("https://static.vm7.io/platform/icon.svg");
  });

  it("preserves whether an origin-only URL has a trailing slash", () => {
    expect(staticUrlForPublicBrand("https://static.vm0.io", "okou")).toBe(
      "https://static.okou.io",
    );
    expect(staticUrlForPublicBrand("https://static.vm0.io/", "okou")).toBe(
      "https://static.okou.io/",
    );
  });
});
