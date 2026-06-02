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
          filename: url,
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
          filename: url,
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

  it("uses markdown link text as the hosted site preview title", () => {
    vi.stubEnv("VITE_ZERO_HOST_DOMAIN", "sites.example.com");
    const url = "https://demo-site-a1b2c3d4.sites.example.com";

    const { blocks } = parseBodyRenderBlocks(`[Launch deck preview](${url})`);

    expect(blocks).toStrictEqual([
      {
        type: "preview",
        id: "preview-1",
        preview: {
          filename: "Launch deck preview",
          url,
          kind: "html",
        },
      },
    ]);
  });

  it("uses markdown link text as the platform HTML preview title", () => {
    const url =
      "https://cdn.vm7.io/artifacts/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.html";

    const { blocks } = parseBodyRenderBlocks(`[Quarterly report](${url})`);

    expect(blocks).toStrictEqual([
      {
        type: "preview",
        id: "preview-1",
        preview: {
          filename: "Quarterly report",
          url,
          kind: "html",
        },
      },
    ]);
  });

  it("renders connector authorize URLs as connector action blocks", () => {
    const url =
      "https://app.vm0.ai/connectors/strapi/authorize?agentId=4f189ea8-ada2-416d-83a9-9c25ddb960c9";

    const { cleanContent, blocks } = parseBodyRenderBlocks(url, {
      previews: false,
    });

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "connector-action",
      id: "connector-action-1",
      connectorType: "strapi",
      agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
      originalUrl: url,
    });
  });

  it("renders markdown connector authorize links as connector action blocks", () => {
    const url =
      "https://app.vm0.ai/connectors/strapi/authorize?agentId=4f189ea8-ada2-416d-83a9-9c25ddb960c9";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `[Connect Strapi](${url})`,
    );

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "connector-action",
      id: "connector-action-1",
      connectorType: "strapi",
      agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
      originalUrl: url,
    });
  });

  it("renders markdown connector connect links with agent IDs as connector action blocks", () => {
    const url =
      "https://app.vm0.ai/connectors/strapi/connect?agentId=4f189ea8-ada2-416d-83a9-9c25ddb960c9";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `[Connect and authorize Strapi](${url})`,
    );

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "connector-action",
      id: "connector-action-1",
      connectorType: "strapi",
      agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
      originalUrl: url,
    });
  });

  it("renders permission URLs as permission action blocks", () => {
    vi.stubEnv("VITE_API_URL", "https://app.vm0.ai");
    const url =
      "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=allow";

    const { cleanContent, blocks } = parseBodyRenderBlocks(url, {
      previews: false,
    });

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "permission-action",
      id: "permission-action-1",
      connectorRef: "vercel",
      agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
      permission: "projects:write",
      action: "allow",
      method: null,
      path: null,
      reason: null,
      search: "ref=vercel&permission=projects%3Awrite&action=allow",
      originalUrl: url,
      href: "/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=allow",
    });
  });

  it("renders platform host variant permission links as permission action blocks", () => {
    vi.stubEnv("VITE_API_URL", "https://www.vm0.ai");
    const url =
      "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=channels%3Aread&action=allow";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `[Manage Slack permissions](${url})`,
      { previews: false },
    );

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "permission-action",
      id: "permission-action-1",
      connectorRef: "slack",
      agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
      permission: "channels:read",
      action: "allow",
      originalUrl: url,
      href: "/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=channels%3Aread&action=allow",
    });
  });

  it("renders tunnel host variant permission links as permission action blocks", () => {
    vi.stubEnv("VITE_API_URL", "https://tunnel-yuma-vm0-api.vm7.ai");
    const url =
      "https://tunnel-yuma-vm0-app.vm7.ai/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `[Manage Slack permissions](${url})`,
      { previews: false },
    );

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "permission-action",
      id: "permission-action-1",
      connectorRef: "slack",
      agentId: "b431c9a7-4f78-4977-aba1-dec4c04b212c",
      permission: "chat:write",
      action: "allow",
      originalUrl: url,
      href: "/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow",
    });
  });

  it("renders permission links with surrounding text as permission action blocks", () => {
    vi.stubEnv("VITE_API_URL", "https://tunnel-yuma-vm0-api.vm7.ai");
    const url =
      "https://tunnel-yuma-vm0-app.vm7.ai/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `请打开这里启用权限：[Manage Slack permissions](${url})`,
      { previews: false },
    );

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "permission-action",
      id: "permission-action-1",
      connectorRef: "slack",
      agentId: "b431c9a7-4f78-4977-aba1-dec4c04b212c",
      permission: "chat:write",
      action: "allow",
      originalUrl: url,
      href: "/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow",
    });
  });

  it("renders tunnel permission links with local API config as permission action blocks", () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    const url =
      "https://tunnel-yuma-vm0-app.vm7.ai/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `请打开这里启用权限：[Manage Slack permissions](${url})`,
      { previews: false },
    );

    expect(cleanContent).toBe("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "permission-action",
      id: "permission-action-1",
      connectorRef: "slack",
      agentId: "b431c9a7-4f78-4977-aba1-dec4c04b212c",
      permission: "chat:write",
      action: "allow",
      originalUrl: url,
      href: "/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow",
    });
  });

  it("does not render external permission links as permission action blocks", () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    const url =
      "https://evil.example/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow";

    const { cleanContent, blocks } = parseBodyRenderBlocks(
      `[Manage Slack permissions](${url})`,
      { previews: false },
    );

    expect(cleanContent).toBe(`[Manage Slack permissions](${url})`);
    expect(blocks).toStrictEqual([
      {
        type: "markdown",
        id: "markdown-1",
        content: `[Manage Slack permissions](${url})`,
      },
    ]);
  });

  it("does not render external connector authorize URLs as action blocks", () => {
    const url =
      "https://evil.example/connectors/strapi/authorize?agentId=4f189ea8-ada2-416d-83a9-9c25ddb960c9";

    const { cleanContent, blocks } = parseBodyRenderBlocks(url, {
      previews: false,
    });

    expect(cleanContent).toBe(url);
    expect(blocks).toStrictEqual([
      {
        type: "markdown",
        id: "markdown-1",
        content: url,
      },
    ]);
  });
});
