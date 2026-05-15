import { describe, it, expect } from "vitest";
import { CONNECTOR_TYPES, connectorTypeSchema } from "../connectors";
import {
  getAvailableConnectorAuthMethods,
  hasRequiredScopes,
  getConnectorManagedSecretNames,
  getConnectorTypeForSecretName,
  getConnectorEnvironmentMapping,
  getConnectorProvidedSecretNames,
  getConnectorAuthMethods,
  getConnectorOAuthConfig,
  getConfiguredConnectorTypes,
  isGoogleOAuthConnector,
} from "../connector-utils";
import { FeatureSwitchKey } from "../feature-switch-key";

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
    // tokens without "workflow" scope (e.g. pre-existing tokens) must reconnect
    expect(hasRequiredScopes("github", ["repo", "project"])).toBe(false);
  });

  it("returns true when all required scopes are present", () => {
    expect(hasRequiredScopes("github", ["repo", "project", "workflow"])).toBe(
      true,
    );
  });

  it("returns true when stored scopes are a superset of required", () => {
    expect(
      hasRequiredScopes("github", [
        "repo",
        "project",
        "workflow",
        "read:org",
        "user",
      ]),
    ).toBe(true);
  });
});

describe("connector auth method config", () => {
  it("declares Stripe CLI auth as a gated connection flow with modes", () => {
    const method = CONNECTOR_TYPES.stripe.authMethods["cli-auth"];

    expect(method).toBeDefined();
    expect(method?.secrets).toStrictEqual({});
    expect(method?.featureFlag).toBe(FeatureSwitchKey.CliAuthStripe);
    expect(CONNECTOR_TYPES.stripe.cliAuth?.modes).toStrictEqual([
      {
        value: "test",
        label: "Test mode",
        description: "Import a Stripe test mode key.",
      },
      {
        value: "live",
        label: "Live mode",
        description: "Import a Stripe live mode key.",
      },
    ]);
  });
});

describe("getAvailableConnectorAuthMethods", () => {
  it("exposes Stripe CLI auth only when its switch is enabled", () => {
    expect(getAvailableConnectorAuthMethods("stripe", {})).toStrictEqual([
      "api-token",
    ]);
    expect(
      getAvailableConnectorAuthMethods("stripe", {
        [FeatureSwitchKey.CliAuthStripe]: true,
      }),
    ).toStrictEqual(["api-token", "cli-auth"]);
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
  it("returns non-empty mapping for connector types that surface env vars to the sandbox", () => {
    for (const type of connectorTypeSchema.options) {
      const mapping = getConnectorEnvironmentMapping(type);
      if (type === "remote-agent" || type === "local-browser") {
        expect(mapping).toEqual({});
        continue;
      }
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

  it("returns correct mapping for apollo connector", () => {
    expect(getConnectorEnvironmentMapping("apollo")).toEqual({
      APOLLO_TOKEN: "$secrets.APOLLO_TOKEN",
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
    // All naming derives from a single prefix XXX:
    //   oauth secrets:      XXX_ACCESS_TOKEN (required), XXX_REFRESH_TOKEN (optional)
    //   environmentMapping: all values -> $secrets.XXX_ACCESS_TOKEN
    //   api-token secrets:  XXX_TOKEN (if api-token auth method exists)
    for (const type of connectorTypeSchema.options) {
      if (!getConnectorOAuthConfig(type)) continue;
      const authMethods = getConnectorAuthMethods(type);
      if (!authMethods["oauth"]) continue;

      const oauthSecrets = Object.keys(authMethods["oauth"].secrets);
      const prefix = oauthSecrets
        .find((s) => {
          return s.endsWith("_ACCESS_TOKEN");
        })
        ?.replace(/_ACCESS_TOKEN$/, "");
      expect(
        prefix,
        `${type}: oauth secrets must include an _ACCESS_TOKEN key`,
      ).toBeDefined();

      // oauth secrets: exactly [XXX_ACCESS_TOKEN] or [XXX_ACCESS_TOKEN, XXX_REFRESH_TOKEN]
      expect(oauthSecrets, `${type}: unexpected oauth secrets`).toSatisfy(
        (s: string[]) => {
          return s.length === 1
            ? s[0] === `${prefix}_ACCESS_TOKEN`
            : s.length === 2 &&
                s.includes(`${prefix}_ACCESS_TOKEN`) &&
                s.includes(`${prefix}_REFRESH_TOKEN`);
        },
      );

      // environmentMapping: must contain XXX_TOKEN, all values -> $secrets.XXX_ACCESS_TOKEN
      const mapping = getConnectorEnvironmentMapping(type);
      const expectedRef = `$secrets.${prefix}_ACCESS_TOKEN`;
      expect(
        mapping[`${prefix}_TOKEN`],
        `${type}: environmentMapping must include ${prefix}_TOKEN`,
      ).toBe(expectedRef);
      for (const [key, value] of Object.entries(mapping)) {
        expect(
          value,
          `${type}: environmentMapping["${key}"] must be ${expectedRef}`,
        ).toBe(expectedRef);
      }

      // api-token (if exists): exactly one secret XXX_TOKEN
      if (authMethods["api-token"]) {
        expect(
          Object.keys(authMethods["api-token"].secrets),
          `${type}: api-token must have exactly ["${prefix}_TOKEN"]`,
        ).toEqual([`${prefix}_TOKEN`]);
      }
    }
  });

  it("api-token-only connectors expose all secrets via environmentMapping with same name", () => {
    for (const type of connectorTypeSchema.options) {
      const authMethods = getConnectorAuthMethods(type);
      if (authMethods["oauth"] || !authMethods["api-token"]) continue;
      if (getConnectorOAuthConfig(type)) continue;

      const secrets = Object.keys(authMethods["api-token"].secrets);
      const mapping = getConnectorEnvironmentMapping(type);
      const mapKeys = Object.keys(mapping);

      // mapping keys must be exactly the same set as secrets
      expect(
        mapKeys.sort(),
        `${type}: environmentMapping keys must match api-token secrets`,
      ).toEqual(secrets.sort());

      // each mapping value must be $secrets.KEY or $vars.KEY (same name)
      for (const key of secrets) {
        expect(
          mapping[key] === `$secrets.${key}` || mapping[key] === `$vars.${key}`,
          `${type}: environmentMapping["${key}"] = "${mapping[key]}", expected $secrets.${key} or $vars.${key}`,
        ).toBe(true);
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

describe("getConfiguredConnectorTypes", () => {
  const emptyEnv = () => {
    return undefined;
  };

  it("includes api-token connectors without environment credentials", () => {
    const configuredTypes = getConfiguredConnectorTypes(emptyEnv);

    expect(configuredTypes).toContain("amplitude");
    expect(configuredTypes).toContain("openai");
  });

  it("includes OAuth connectors only when client id and secret are configured", () => {
    const env = new Map([
      ["AIRTABLE_OAUTH_CLIENT_ID", "airtable-client-id"],
      ["AIRTABLE_OAUTH_CLIENT_SECRET", "airtable-client-secret"],
      ["SENTRY_OAUTH_CLIENT_ID", "sentry-client-id"],
    ]);

    const configuredTypes = getConfiguredConnectorTypes((name) => {
      return env.get(name);
    });

    expect(configuredTypes).toContain("airtable");
    expect(configuredTypes).not.toContain("sentry");
  });

  it("includes all connectors that share a configured OAuth app", () => {
    const env = new Map([
      ["GOOGLE_OAUTH_CLIENT_ID", "google-client-id"],
      ["GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret"],
    ]);

    const configuredTypes = getConfiguredConnectorTypes((name) => {
      return env.get(name);
    });

    expect(configuredTypes).toEqual(
      expect.arrayContaining([
        "gmail",
        "google-calendar",
        "google-docs",
        "google-drive",
        "google-meet",
        "google-sheets",
      ]),
    );
  });

  it("includes active OAuth connectors when their runtime env is configured", () => {
    const oauthTypesWithoutRuntimeClientCredentials = new Set([
      "codex-oauth",
      "mailchimp",
    ]);
    const activeOAuthTypes = connectorTypeSchema.options.filter((type) => {
      return (
        getConnectorOAuthConfig(type) &&
        !oauthTypesWithoutRuntimeClientCredentials.has(type)
      );
    });

    const configuredTypes = getConfiguredConnectorTypes(() => {
      return "configured";
    });

    expect(configuredTypes).toEqual(expect.arrayContaining(activeOAuthTypes));
  });

  it("includes computer only when both ngrok env vars are configured", () => {
    const partialComputerEnv = new Map([["NGROK_API_KEY", "ngrok-api-key"]]);
    const fullComputerEnv = new Map([
      ["NGROK_API_KEY", "ngrok-api-key"],
      ["NGROK_COMPUTER_CONNECTOR_DOMAIN", "computer.example.com"],
    ]);

    expect(
      getConfiguredConnectorTypes((name) => {
        return partialComputerEnv.get(name);
      }),
    ).not.toContain("computer");
    expect(
      getConfiguredConnectorTypes((name) => {
        return fullComputerEnv.get(name);
      }),
    ).toContain("computer");
  });

  it("returns connector types in sorted order", () => {
    const configuredTypes = getConfiguredConnectorTypes(emptyEnv);

    expect(configuredTypes).toStrictEqual([...configuredTypes].sort());
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

describe("getConnectorOAuthConfig - google-meet scopes", () => {
  it("uses meetings.space.readonly for google meet oauth scopes", () => {
    const config = getConnectorOAuthConfig("google-meet");
    expect(config).not.toBeNull();
    const scopes = config!.scopes;
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/meetings.space.readonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/meetings.conferencerecords.readonly",
    );
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

describe("isGoogleOAuthConnector", () => {
  const GOOGLE_CONNECTORS = [
    "gmail",
    "google-ads",
    "google-sheets",
    "google-docs",
    "google-drive",
    "google-calendar",
    "google-meet",
  ] as const;

  it("returns true for all known Google OAuth connectors", () => {
    for (const type of GOOGLE_CONNECTORS) {
      expect(
        isGoogleOAuthConnector(type),
        `${type} should be identified as a Google OAuth connector`,
      ).toBe(true);
    }
  });

  it("returns false for non-Google OAuth connectors", () => {
    const nonGoogleOAuth = ["github", "notion", "slack", "linear"] as const;
    for (const type of nonGoogleOAuth) {
      expect(
        isGoogleOAuthConnector(type),
        `${type} should not be identified as a Google OAuth connector`,
      ).toBe(false);
    }
  });

  it("returns false for api-token-only connectors", () => {
    const apiTokenOnly = ["axiom", "atlassian", "ahrefs"] as const;
    for (const type of apiTokenOnly) {
      expect(
        isGoogleOAuthConnector(type),
        `${type} has no OAuth config and should return false`,
      ).toBe(false);
    }
  });

  it("returns true only for connectors whose OAuth authorizationUrl hostname is accounts.google.com", () => {
    for (const type of connectorTypeSchema.options) {
      const result = isGoogleOAuthConnector(type);
      const oauthConfig = getConnectorOAuthConfig(type);

      if (result) {
        // If classified as Google, the OAuth URL must point to accounts.google.com
        const authorizationUrl = oauthConfig?.authorizationUrl;
        expect(
          authorizationUrl,
          `${type}: Google connector must have an authorizationUrl`,
        ).toBeDefined();
        expect(
          new URL(authorizationUrl as string).hostname,
          `${type}: Google connector authorizationUrl must use accounts.google.com`,
        ).toBe("accounts.google.com");
      } else if (oauthConfig?.authorizationUrl) {
        // If not classified as Google but has an OAuth URL, it must NOT be accounts.google.com
        let hostname: string | null = null;
        try {
          hostname = new URL(oauthConfig.authorizationUrl).hostname;
        } catch {
          // invalid URL — isGoogleOAuthConnector correctly returns false
        }
        if (hostname) {
          expect(
            hostname,
            `${type}: non-Google connector must not use accounts.google.com`,
          ).not.toBe("accounts.google.com");
        }
      }
    }
  });

  it("covers exactly the same set as the legacy hardcoded type list", () => {
    // Ensures isGoogleOAuthConnector detects at least the 6 connectors
    // previously handled by the hardcoded isGoogleConnector function.
    const detected = connectorTypeSchema.options.filter(isGoogleOAuthConnector);
    for (const type of GOOGLE_CONNECTORS) {
      expect(
        detected,
        `${type} must be detected by isGoogleOAuthConnector`,
      ).toContain(type);
    }
    // No non-Google connector should slip through
    expect(detected.length).toBe(GOOGLE_CONNECTORS.length);
  });
});
