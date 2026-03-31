import { describe, it, expect } from "vitest";
import {
  hasRequiredScopes,
  getConnectorManagedSecretNames,
  getConnectorTypeForSecretName,
  getConnectorEnvironmentMapping,
  getConnectorProvidedSecretNames,
  getConnectorAuthMethods,
  getConnectorOAuthConfig,
  connectorTypeSchema,
} from "../connectors";

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

describe("getConnectorEnvironmentMapping", () => {
  it("returns non-empty mapping for all connector types", () => {
    for (const type of connectorTypeSchema.options) {
      const mapping = getConnectorEnvironmentMapping(type);
      expect(
        Object.keys(mapping).length,
        `${type} has empty environmentMapping`,
      ).toBeGreaterThan(0);
    }
  });

  it("returns correct mapping for API-token-only connector", () => {
    expect(getConnectorEnvironmentMapping("axiom")).toEqual({
      AXIOM_TOKEN: "$secrets.AXIOM_TOKEN",
    });
  });

  it("returns correct mapping for API-token connector with variables", () => {
    expect(getConnectorEnvironmentMapping("jira")).toEqual({
      JIRA_API_TOKEN: "$secrets.JIRA_API_TOKEN",
      JIRA_DOMAIN: "$vars.JIRA_DOMAIN",
      JIRA_EMAIL: "$vars.JIRA_EMAIL",
    });
  });

  it("returns correct mapping for hybrid connector", () => {
    expect(getConnectorEnvironmentMapping("ahrefs")).toEqual({
      AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
    });
  });

  it("returns correct mapping for OAuth-only connector", () => {
    expect(getConnectorEnvironmentMapping("github")).toEqual({
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    });
  });

  it("OAuth connectors have consistent secrets and environmentMapping naming", () => {
    for (const type of connectorTypeSchema.options) {
      const oauthConfig = getConnectorOAuthConfig(type);
      if (!oauthConfig) continue;

      const authMethods = getConnectorAuthMethods(type);
      const oauthMethod = authMethods["oauth"];
      if (!oauthMethod) continue;

      const secretNames = Object.keys(oauthMethod.secrets);
      const mapping = getConnectorEnvironmentMapping(type);

      // OAuth secrets must include exactly one XXX_ACCESS_TOKEN
      const accessTokens = secretNames.filter((s) =>
        s.endsWith("_ACCESS_TOKEN"),
      );
      expect(
        accessTokens.length,
        `${type}: oauth secrets must have exactly one _ACCESS_TOKEN key, got: ${secretNames.join(", ")}`,
      ).toBe(1);

      // If refresh token exists, must be exactly one with matching prefix
      const prefix = accessTokens[0]!.replace(/_ACCESS_TOKEN$/, "");
      const refreshTokens = secretNames.filter((s) =>
        s.endsWith("_REFRESH_TOKEN"),
      );
      expect(
        refreshTokens.length,
        `${type}: must have 0 or 1 _REFRESH_TOKEN, got: ${refreshTokens.join(", ")}`,
      ).toBeLessThanOrEqual(1);
      if (refreshTokens.length === 1) {
        expect(
          refreshTokens[0],
          `${type}: refresh token must be ${prefix}_REFRESH_TOKEN`,
        ).toBe(`${prefix}_REFRESH_TOKEN`);
      }

      // environmentMapping must map XXX_TOKEN -> $secrets.XXX_ACCESS_TOKEN (same prefix)
      expect(
        mapping[`${prefix}_TOKEN`],
        `${type}: environmentMapping must map ${prefix}_TOKEN -> $secrets.${prefix}_ACCESS_TOKEN`,
      ).toBe(`$secrets.${prefix}_ACCESS_TOKEN`);

      // environmentMapping must only contain mappings to the same access token
      const expectedValue = `$secrets.${prefix}_ACCESS_TOKEN`;
      for (const [key, value] of Object.entries(mapping)) {
        expect(
          value,
          `${type}: environmentMapping["${key}"] must point to ${expectedValue}`,
        ).toBe(expectedValue);
      }

      // If both oauth and api-token exist, api-token must have exactly one secret: ${prefix}_TOKEN
      const apiTokenMethod = authMethods["api-token"];
      if (apiTokenMethod) {
        const apiSecrets = Object.keys(apiTokenMethod.secrets);
        expect(
          apiSecrets,
          `${type}: api-token with oauth must have exactly ["${prefix}_TOKEN"]`,
        ).toEqual([`${prefix}_TOKEN`]);
      }
    }
  });

  it("all mapping values use $secrets. or $vars. prefix", () => {
    for (const type of connectorTypeSchema.options) {
      const mapping = getConnectorEnvironmentMapping(type);
      for (const [key, value] of Object.entries(mapping)) {
        expect(
          value.startsWith("$secrets.") || value.startsWith("$vars."),
          `${type}.environmentMapping["${key}"] = "${value}" — must start with $secrets. or $vars.`,
        ).toBe(true);
      }
    }
  });
});

describe("getConnectorProvidedSecretNames", () => {
  it("returns env var names for API-token-only connector", () => {
    const names = getConnectorProvidedSecretNames(["axiom"]);
    expect(names.has("AXIOM_TOKEN")).toBe(true);
  });

  it("returns env var names for OAuth connector", () => {
    const names = getConnectorProvidedSecretNames(["github"]);
    expect(names.has("GH_TOKEN")).toBe(true);
    expect(names.has("GITHUB_TOKEN")).toBe(true);
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
