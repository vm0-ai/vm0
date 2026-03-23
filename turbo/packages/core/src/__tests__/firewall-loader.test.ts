import { describe, it, expect, vi } from "vitest";
import { fetchFirewallConfig, buildFirewallYamlUrl } from "../firewall-loader";
import type { FetchFn } from "../firewall-loader";

/** Helper to create a mock fetch function returning given body and status */
function mockFetch(body: string, status = 200, statusText = "OK"): FetchFn {
  return vi
    .fn<FetchFn>()
    .mockResolvedValue(new Response(body, { status, statusText }));
}

describe("buildFirewallYamlUrl", () => {
  it("should build URL for bare name", () => {
    expect(buildFirewallYamlUrl("my-firewall")).toBe(
      "https://raw.githubusercontent.com/vm0-ai/vm0-firewalls/main/my-firewall/firewall.yaml",
    );
  });

  it("should build URL for full GitHub URL", () => {
    expect(
      buildFirewallYamlUrl("https://github.com/acme/firewalls/tree/v2/custom"),
    ).toBe(
      "https://raw.githubusercontent.com/acme/firewalls/v2/custom/firewall.yaml",
    );
  });
});

describe("fetchFirewallConfig", () => {
  it("should fetch and parse a valid firewall YAML", async () => {
    const yamlContent = `
name: custom-api
description: Custom API integration
apis:
  - base: https://api.custom.com
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.CUSTOM_TOKEN }}"
    permissions:
      - name: read
        description: Read access
        rules:
          - GET /data/{id}
      - name: write
        rules:
          - POST /data
placeholders:
  CUSTOM_TOKEN: "tok_placeholder"
`;

    const config = await fetchFirewallConfig(
      "custom-api",
      mockFetch(yamlContent),
    );

    expect(config.name).toBe("custom-api");
    expect(config.description).toBe("Custom API integration");
    expect(config.apis).toHaveLength(1);
    expect(config.apis[0]!.base).toBe("https://api.custom.com");
    expect(config.apis[0]!.permissions).toHaveLength(2);
    expect(config.placeholders).toEqual({ CUSTOM_TOKEN: "tok_placeholder" });
  });

  it("should fetch config without optional fields", async () => {
    const yamlContent = `
name: minimal-api
apis:
  - base: https://api.minimal.com
    auth:
      headers:
        X-Api-Key: "\${{ secrets.API_KEY }}"
`;

    const config = await fetchFirewallConfig(
      "minimal-api",
      mockFetch(yamlContent),
    );

    expect(config.name).toBe("minimal-api");
    expect(config.description).toBeUndefined();
    expect(config.apis).toHaveLength(1);
    expect(config.apis[0]!.permissions).toBeUndefined();
    expect(config.placeholders).toBeUndefined();
  });

  it("should throw on 404 response", async () => {
    await expect(
      fetchFirewallConfig(
        "nonexistent",
        mockFetch("Not Found", 404, "Not Found"),
      ),
    ).rejects.toThrow('Failed to fetch firewall config for "nonexistent"');
  });

  it("should throw on invalid YAML syntax", async () => {
    await expect(
      fetchFirewallConfig("bad-yaml", mockFetch("name: [invalid yaml{")),
    ).rejects.toThrow('Invalid YAML in firewall config "bad-yaml"');
  });

  it("should throw on missing required name field", async () => {
    const yamlContent = `
apis:
  - base: https://api.example.com
    auth:
      headers:
        Authorization: "Bearer token"
`;

    await expect(
      fetchFirewallConfig("no-name", mockFetch(yamlContent)),
    ).rejects.toThrow('Invalid firewall config "no-name"');
  });

  it("should throw on empty apis array", async () => {
    const yamlContent = `
name: empty-apis
apis: []
`;

    await expect(
      fetchFirewallConfig("empty-apis", mockFetch(yamlContent)),
    ).rejects.toThrow('Invalid firewall config "empty-apis"');
  });

  it("should throw when response exceeds max size", async () => {
    const largeContent = "x".repeat(129 * 1024); // > 128KB
    await expect(
      fetchFirewallConfig("too-large", mockFetch(largeContent)),
    ).rejects.toThrow("exceeds maximum size");
  });

  it("should throw early when Content-Length header exceeds max size", async () => {
    const fetchFn: FetchFn = vi.fn<FetchFn>().mockResolvedValue(
      new Response("small body", {
        status: 200,
        headers: { "Content-Length": String(200 * 1024) },
      }),
    );
    await expect(fetchFirewallConfig("large-header", fetchFn)).rejects.toThrow(
      "exceeds maximum size",
    );
  });

  it("should return builtin config without fetching", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const config = await fetchFirewallConfig("github", fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(config.name).toBe("github");
    expect(config.apis.length).toBeGreaterThan(0);
    expect(config.placeholders).toBeDefined();
  });

  it("should pass correct URL to fetch function", async () => {
    const fetchFn = mockFetch(
      "name: x\napis:\n  - base: https://x.com\n    auth:\n      headers:\n        X: y",
    );

    await fetchFirewallConfig("my-firewall", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/vm0-ai/vm0-firewalls/main/my-firewall/firewall.yaml",
    );
  });
});
