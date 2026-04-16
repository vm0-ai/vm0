import { describe, it, expect } from "vitest";
import { extractSecretNamesFromApis } from "../firewalls";

describe("extractSecretNamesFromApis with auth.base and auth.query", () => {
  it("extracts secrets from auth.headers only", () => {
    const apis = [
      {
        base: "https://api.github.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",
          },
        },
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual(["GITHUB_TOKEN"]);
  });

  it("extracts secrets from auth.base", () => {
    const apis = [
      {
        base: "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
        auth: {
          headers: {},
          base: "${{ secrets.DISCORD_WEBHOOK_URL }}",
        },
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual(["DISCORD_WEBHOOK_URL"]);
  });

  it("extracts secrets from both auth.headers and auth.base", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            "X-Custom": "${{ secrets.CUSTOM_HEADER }}",
          },
          base: "${{ secrets.WEBHOOK_URL }}",
        },
      },
    ];
    const result = extractSecretNamesFromApis(apis);
    expect(result).toContain("CUSTOM_HEADER");
    expect(result).toContain("WEBHOOK_URL");
    expect(result).toHaveLength(2);
  });

  it("returns empty when auth.base has no secret references", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {},
          base: "https://static-url.com/path",
        },
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual([]);
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
    expect(extractSecretNamesFromApis(apis)).toEqual([]);
  });

  it("extracts secrets from auth.query", () => {
    const apis = [
      {
        base: "https://serpapi.com",
        auth: {
          headers: {},
          query: {
            api_key: "${{ secrets.SERPAPI_TOKEN }}",
          },
        },
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual(["SERPAPI_TOKEN"]);
  });

  it("extracts secrets from both auth.headers and auth.query", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
          query: {
            key: "${{ secrets.QUERY_KEY }}",
          },
        },
      },
    ];
    const result = extractSecretNamesFromApis(apis);
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
            Authorization: "Bearer ${{ secrets.TOKEN }}",
          },
        },
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual(["TOKEN"]);
  });

  it("extracts secrets when auth.headers is omitted", () => {
    const apis = [
      {
        base: "https://serpapi.com",
        auth: {
          query: {
            api_key: "${{ secrets.SERPAPI_TOKEN }}",
          },
        },
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual(["SERPAPI_TOKEN"]);
  });

  it("returns empty when auth has no fields", () => {
    const apis = [
      {
        base: "https://example.com",
        auth: {},
      },
    ];
    expect(extractSecretNamesFromApis(apis)).toEqual([]);
  });
});
