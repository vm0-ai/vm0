import { describe, expect, it, vi } from "vitest";
import { parseBodyRenderBlocks } from "../parse-body-blocks.ts";

describe("parseBodyRenderBlocks", () => {
  it.each([
    "（公开 URL，可以分享给设计/PM）。",
    "，公开 URL，可以分享给设计/PM。",
  ])(
    "does not include annotation text after a platform file URL: %s",
    (suffix) => {
      const imageUrl =
        "https://www.vm0.ai/f/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/image-24b42fb4.png";

      const { blocks } = parseBodyRenderBlocks(
        `图也存好了：${imageUrl}${suffix}`,
      );

      expect(blocks).toStrictEqual([
        {
          type: "preview",
          id: "preview-1",
          preview: {
            filename: "image-24b42fb4.png",
            url: imageUrl,
            kind: "image",
          },
        },
      ]);
    },
  );

  it("renders CDN artifact URLs as inline preview cards", () => {
    const imageUrl =
      "https://cdn.vm7.io/artifacts/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/image-24b42fb4.png";

    const { blocks } = parseBodyRenderBlocks(`图也存好了：${imageUrl}`);

    expect(blocks).toStrictEqual([
      {
        type: "preview",
        id: "preview-1",
        preview: {
          filename: "image-24b42fb4.png",
          url: imageUrl,
          kind: "image",
        },
      },
    ]);
  });

  it("keeps artifact URLs as markdown when previews are disabled", () => {
    const imageUrl =
      "https://cdn.vm7.io/artifacts/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/image-24b42fb4.png";
    const content = `图也存好了：${imageUrl}`;

    const { cleanContent, blocks } = parseBodyRenderBlocks(content, {
      previews: false,
    });

    expect(cleanContent).toBe(content);
    expect(blocks).toStrictEqual([
      {
        type: "markdown",
        id: "markdown-1",
        content,
      },
    ]);
  });

  it("renders hosted site URLs as html previews", () => {
    vi.stubEnv("VITE_ZERO_HOST_DOMAIN", "sites.example.com");
    const url = "https://demo-site-a1b2c3d4.sites.example.com";

    const { blocks } = parseBodyRenderBlocks(url);

    expect(blocks).toStrictEqual([
      {
        type: "preview",
        id: "preview-1",
        preview: {
          filename: "demo-site-a1b2c3d4.html",
          url,
          kind: "html",
        },
      },
    ]);
  });

  it("renders vm7 hosted site URLs from configured env", () => {
    vi.stubEnv("VITE_ZERO_HOST_DOMAIN", "sites.vm7.io");
    const url = "https://li-hua-mao-guide-0520-35a4112d.sites.vm7.io";

    const { blocks } = parseBodyRenderBlocks(url);

    expect(blocks).toStrictEqual([
      {
        type: "preview",
        id: "preview-1",
        preview: {
          filename: "li-hua-mao-guide-0520-35a4112d.html",
          url,
          kind: "html",
        },
      },
    ]);
  });

  it("keeps non-hosted external URLs as markdown", () => {
    vi.stubEnv("VITE_ZERO_HOST_DOMAIN", "sites.example.com");
    const url = "https://example.com/index.html";

    const { blocks } = parseBodyRenderBlocks(url);

    expect(blocks).toStrictEqual([
      {
        type: "markdown",
        id: "markdown-1",
        content: url,
      },
    ]);
  });
});
