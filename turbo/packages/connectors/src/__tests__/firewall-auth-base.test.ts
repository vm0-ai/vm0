import { describe, it, expect } from "vitest";
import {
  extractAuthNamesFromApis,
  firewallConfigSchema,
} from "../firewall-types";

describe("extractAuthNamesFromApis with auth.base and auth.query", () => {
  it("extracts auth keys from auth.headers only", () => {
    const apis = [
      {
        base: "https://api.github.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ auth.GITHUB_TOKEN }}",
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["GITHUB_TOKEN"]);
  });

  it("extracts auth keys from auth.base", () => {
    const apis = [
      {
        base: "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
        auth: {
          headers: {},
          base: "${{ auth.DISCORD_WEBHOOK_URL }}",
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["DISCORD_WEBHOOK_URL"]);
  });

  it("extracts auth keys from both auth.headers and auth.base", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            "X-Custom": "${{ auth.CUSTOM_HEADER }}",
          },
          base: "${{ auth.WEBHOOK_URL }}",
        },
      },
    ];
    const result = extractAuthNamesFromApis(apis);
    expect(result).toContain("CUSTOM_HEADER");
    expect(result).toContain("WEBHOOK_URL");
    expect(result).toHaveLength(2);
  });

  it("returns empty when auth.base has no auth references", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {},
          base: "https://static-url.com/path",
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual([]);
  });

  it("skips auth.base when not present", () => {
    const apis = [
      {
        base: "https://api.github.com",
        auth: {
          headers: {},
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual([]);
  });

  it("extracts auth keys from auth.query", () => {
    const apis = [
      {
        base: "https://serpapi.com",
        auth: {
          headers: {},
          query: {
            api_key: "${{ auth.SERPAPI_TOKEN }}",
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["SERPAPI_TOKEN"]);
  });

  it("extracts auth keys from both auth.headers and auth.query", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ auth.API_TOKEN }}",
          },
          query: {
            key: "${{ auth.QUERY_KEY }}",
          },
        },
      },
    ];
    const result = extractAuthNamesFromApis(apis);
    expect(result).toContain("API_TOKEN");
    expect(result).toContain("QUERY_KEY");
    expect(result).toHaveLength(2);
  });

  it("skips auth.query when not present", () => {
    const apis = [
      {
        base: "https://api.github.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ auth.TOKEN }}",
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["TOKEN"]);
  });

  it("extracts auth keys when auth.headers is omitted", () => {
    const apis = [
      {
        base: "https://serpapi.com",
        auth: {
          query: {
            api_key: "${{ auth.SERPAPI_TOKEN }}",
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["SERPAPI_TOKEN"]);
  });

  it("returns empty when auth has no fields", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {},
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual([]);
  });

  it("extracts auth keys from basic() with auth args", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            Authorization: "${{ basic(auth.USER, auth.TOKEN) }}",
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["USER", "TOKEN"]);
  });

  it("does not extract auth keys from basic() literal args", () => {
    const apis = [
      {
        base: "https://github.com/{owner}/{repo}.git",
        auth: {
          headers: {
            Authorization: '${{ basic("x-access-token", auth.GITHUB_TOKEN) }}',
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["GITHUB_TOKEN"]);
  });

  it("returns empty for basic() with both literal args", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            Authorization: '${{ basic("admin", "hunter2") }}',
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual([]);
  });

  it("does not extract literals that contain auth.X-looking text", () => {
    // A literal whose content happens to look like "auth.FAKE" must NOT
    // be treated as a secret reference — literals are opaque strings.
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            Authorization: '${{ basic("auth.FAKE", auth.REAL) }}',
          },
        },
      },
    ];
    expect(extractAuthNamesFromApis(apis)).toEqual(["REAL"]);
  });

  it("rejects legacy secrets and vars references in auth templates", () => {
    const parsed = firewallConfigSchema.safeParse({
      name: "legacy",
      apis: [
        {
          base: "https://example.com",
          auth: {
            headers: {
              Authorization: "Bearer ${{ secrets.TOKEN }}",
            },
            query: {
              user: "${{ vars.USER }}",
            },
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
