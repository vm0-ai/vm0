import { describe, expect, it } from "vitest";
import { r2ImageTransformUrl } from "../r2-image-transform";

describe("r2ImageTransformUrl", () => {
  it("adds image transform directives for vm0 CDN artifact URLs", () => {
    expect(
      r2ImageTransformUrl("https://cdn.vm0.io/artifacts/user/id/image.png", {
        width: 320,
        height: 180,
      }),
    ).toBe(
      "https://cdn.vm0.io/cdn-cgi/image/width=320,height=180,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.png",
    );
  });

  it("supports vm7 CDN artifact URLs", () => {
    expect(
      r2ImageTransformUrl("https://cdn.vm7.io/artifacts/user/id/image.jpg", {
        width: 96,
        height: 96,
      }),
    ).toBe(
      "https://cdn.vm7.io/cdn-cgi/image/width=96,height=96,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.jpg",
    );
  });

  it("preserves search params and hashes", () => {
    expect(
      r2ImageTransformUrl(
        "https://cdn.vm0.io/artifacts/user/id/image.png?token=abc#preview",
        { width: 800 },
      ),
    ).toBe(
      "https://cdn.vm0.io/cdn-cgi/image/width=800,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.png?token=abc#preview",
    );
  });

  it("leaves already transformed URLs untouched", () => {
    const url =
      "https://cdn.vm0.io/cdn-cgi/image/width=100,height=100,fit=scale-down/artifacts/user/id/image.png";

    expect(r2ImageTransformUrl(url, { width: 400, height: 300 })).toBe(url);
  });

  it("leaves non-R2 URLs untouched", () => {
    const url = "https://example.com/image.png";
    expect(r2ImageTransformUrl(url, { width: 400, height: 300 })).toBe(url);
    expect(r2ImageTransformUrl("/local/image.png", { width: 400 })).toBe(
      "/local/image.png",
    );
  });
});
