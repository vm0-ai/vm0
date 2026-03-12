import { describe, it, expect } from "vitest";
import {
  hasRequiredScopes,
  CONNECTOR_TYPES,
  getConnectorManagedSecretNames,
  getConnectorTypeForSecretName,
} from "../connectors";
import type { ConnectorType } from "../connectors";
import { getServiceConfig } from "../services";

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

describe("getConnectorManagedSecretNames", () => {
  it("includes OAuth environmentMapping keys for OAuth connectors", () => {
    const managed = getConnectorManagedSecretNames(["github"]);
    // OAuth env mapping keys
    expect(managed.has("GH_TOKEN")).toBe(true);
    expect(managed.has("GITHUB_TOKEN")).toBe(true);
    // OAuth auth method secret
    expect(managed.has("GITHUB_ACCESS_TOKEN")).toBe(true);
  });

  it("includes api-token auth method secrets for api-token-only connectors", () => {
    const managed = getConnectorManagedSecretNames(["atlassian"]);
    expect(managed.has("ATLASSIAN_TOKEN")).toBe(true);
    expect(managed.has("ATLASSIAN_EMAIL")).toBe(true);
    expect(managed.has("ATLASSIAN_DOMAIN")).toBe(true);
  });

  it("returns empty set for empty input", () => {
    const managed = getConnectorManagedSecretNames([]);
    expect(managed.size).toBe(0);
  });

  it("combines managed names across multiple connector types", () => {
    const managed = getConnectorManagedSecretNames(["github", "atlassian"]);
    expect(managed.has("GH_TOKEN")).toBe(true);
    expect(managed.has("ATLASSIAN_TOKEN")).toBe(true);
  });
});

describe("getConnectorTypeForSecretName", () => {
  it("finds connector type for OAuth env mapping key", () => {
    expect(getConnectorTypeForSecretName("GH_TOKEN")).toBe("github");
    expect(getConnectorTypeForSecretName("GITHUB_TOKEN")).toBe("github");
  });

  it("finds connector type for api-token auth method secret", () => {
    expect(getConnectorTypeForSecretName("ATLASSIAN_TOKEN")).toBe("atlassian");
    expect(getConnectorTypeForSecretName("ATLASSIAN_EMAIL")).toBe("atlassian");
    expect(getConnectorTypeForSecretName("ATLASSIAN_DOMAIN")).toBe("atlassian");
  });

  it("finds connector type for OAuth auth method secret", () => {
    expect(getConnectorTypeForSecretName("GITHUB_ACCESS_TOKEN")).toBe("github");
  });

  it("returns null for unknown secret name", () => {
    expect(getConnectorTypeForSecretName("UNKNOWN_SECRET")).toBeNull();
  });
});

describe("getServiceConfig", () => {
  it("returns proxy config for known connector types", () => {
    const config = getServiceConfig("github");
    expect(config).toBeDefined();
    expect(config!.apis[0]!.base).toBe("https://api.github.com");
    expect(config!.apis[0]!.auth.headers.Authorization).toBe(
      "Bearer ${secrets.GITHUB_TOKEN}",
    );
    expect(config!.placeholders).toEqual({
      GH_TOKEN: "gho_vm0placeholder0000000000000000000000",
      GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000",
    });
  });

  it("returns config with multiple services for slack", () => {
    const config = getServiceConfig("slack");
    expect(config).toBeDefined();
    expect(config!.apis.map((s) => s.base)).toEqual([
      "https://slack.com/api",
      "https://files.slack.com",
    ]);
    expect(config!.placeholders).toEqual({
      SLACK_TOKEN: "xoxb-0000-0000-vm0placeholder",
    });
  });

  it("returns config with custom headers for notion", () => {
    const config = getServiceConfig("notion");
    expect(config).toBeDefined();
    expect(config!.apis[0]!.auth.headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("returns undefined for computer connector (no proxy support)", () => {
    const config = getServiceConfig("computer");
    expect(config).toBeUndefined();
  });

  it("all proxy configs have valid services and auth headers", () => {
    const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

    for (const type of allTypes) {
      const config = getServiceConfig(type);
      if (!config) continue;

      expect(
        config.apis.length,
        `${type} should have at least one service`,
      ).toBeGreaterThan(0);
      for (const svc of config.apis) {
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
