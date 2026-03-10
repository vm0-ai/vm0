import { describe, it, expect } from "vitest";
import {
  hasRequiredScopes,
  getConnectorProxyConfig,
  CONNECTOR_TYPES,
} from "../connectors";
import type { ConnectorType } from "../connectors";

describe("hasRequiredScopes", () => {
  it("returns true for non-OAuth connector type", () => {
    // computer connector has no oauth config
    expect(hasRequiredScopes("computer", null)).toBe(true);
  });

  it("returns true when connector has empty required scopes", () => {
    // notion has scopes: []
    expect(hasRequiredScopes("notion", null)).toBe(true);
    expect(hasRequiredScopes("notion", [])).toBe(true);
    expect(hasRequiredScopes("notion", ["some-scope"])).toBe(true);
  });

  it("returns false when storedScopes is null", () => {
    // github requires ["repo"]
    expect(hasRequiredScopes("github", null)).toBe(false);
  });

  it("returns false when required scope is missing", () => {
    expect(hasRequiredScopes("github", [])).toBe(false);
    expect(hasRequiredScopes("github", ["read:org"])).toBe(false);
    expect(hasRequiredScopes("github", ["repo"])).toBe(false);
  });

  it("returns true when all required scopes are present", () => {
    expect(hasRequiredScopes("github", ["repo", "project"])).toBe(true);
  });

  it("returns true when stored scopes are a superset of required", () => {
    expect(
      hasRequiredScopes("github", ["repo", "project", "read:org", "user"]),
    ).toBe(true);
  });
});

describe("getConnectorProxyConfig", () => {
  it("returns proxy config for known connector types", () => {
    const config = getConnectorProxyConfig("github");
    expect(config).toBeDefined();
    expect(config!.services[0]!.base).toBe("https://api.github.com");
    expect(config!.services[0]!.auth.headers.Authorization).toBe(
      "Bearer ${secrets.GITHUB_TOKEN}",
    );
    expect(config!.placeholders).toEqual({
      GH_TOKEN: "gho_vm0placeholder0000000000000000000000",
      GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000",
    });
  });

  it("returns config with multiple services for slack", () => {
    const config = getConnectorProxyConfig("slack");
    expect(config).toBeDefined();
    expect(config!.services.map((s) => s.base)).toEqual([
      "https://slack.com/api",
      "https://files.slack.com",
    ]);
    expect(config!.placeholders).toEqual({
      SLACK_TOKEN: "xoxb-0000-0000-vm0placeholder",
    });
  });

  it("returns config with custom headers for notion", () => {
    const config = getConnectorProxyConfig("notion");
    expect(config).toBeDefined();
    expect(config!.services[0]!.auth.headers["Notion-Version"]).toBe(
      "2022-06-28",
    );
  });

  it("returns undefined for computer connector (no proxy support)", () => {
    const config = getConnectorProxyConfig("computer");
    expect(config).toBeUndefined();
  });

  it("all proxy configs have valid services and auth headers", () => {
    const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

    for (const type of allTypes) {
      const config = getConnectorProxyConfig(type);
      if (!config) continue;

      expect(
        config.services.length,
        `${type} should have at least one service`,
      ).toBeGreaterThan(0);
      for (const svc of config.services) {
        expect(svc.base, `${type} service base should be https URL`).toMatch(
          /^https:\/\//,
        );
        expect(
          Object.keys(svc.auth.headers).length,
          `${type} service should have at least one auth header`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
