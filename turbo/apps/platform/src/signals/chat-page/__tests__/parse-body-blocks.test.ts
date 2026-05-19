import { describe, expect, it } from "vitest";
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
});
