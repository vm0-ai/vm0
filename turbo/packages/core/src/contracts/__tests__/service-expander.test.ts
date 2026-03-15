import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import type { ExpandedServiceConfig } from "../services";
import { getServiceConfig } from "../services";
import {
  expandServiceConfigs,
  validateRule,
  validateBaseUrl,
} from "../service-expander";

describe("expandServiceConfigs", () => {
  function makeConfig(
    services: Record<string, { permissions: string[] | "all" }>,
  ) {
    return {
      version: "1.0",
      agents: {
        myagent: {
          framework: "claude-code",
          experimental_services: services,
        },
      },
    };
  }

  function getExpanded(config: ReturnType<typeof makeConfig>) {
    expandServiceConfigs(config);
    return config.agents.myagent
      .experimental_services as unknown as ExpandedServiceConfig[];
  }

  it("should expand service with permissions: all", () => {
    const config = makeConfig({ github: { permissions: "all" } });
    const expanded = getExpanded(config);

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.name).toBe("github");
    expect(expanded[0]!.ref).toBe("github");
    expect(expanded[0]!.apis).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.base).toBe("https://api.github.com");
    // GitHub has 9 granular permission groups
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => p.name);
    expect(permNames).toContain("repo-read");
    expect(permNames).toContain("issues-read");
    expect(permNames).toContain("pull-requests-read");
    expect(permNames).toContain("search");
  });

  it("should expand service with specific permissions", () => {
    const config = makeConfig({
      github: { permissions: ["issues-read", "issues-write"] },
    });
    const expanded = getExpanded(config);

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(2);
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => p.name);
    expect(permNames).toContain("issues-read");
    expect(permNames).toContain("issues-write");
  });

  it("should include placeholders when service has them", () => {
    const config = makeConfig({ github: { permissions: "all" } });
    const expanded = getExpanded(config);

    expect(expanded[0]!.placeholders).toEqual({
      GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000",
    });
  });

  it("should expand multiple services", () => {
    const config = makeConfig({
      github: { permissions: "all" },
      slack: { permissions: "all" },
    });
    const expanded = getExpanded(config);

    expect(expanded).toHaveLength(2);
    const names = expanded.map((s) => s.name);
    expect(names).toContain("github");
    expect(names).toContain("slack");
  });

  it("should keep all api_entries when shared permission is selected", () => {
    // slack has 2 api entries (slack.com/api and files.slack.com),
    // both with full-access. Selecting full-access keeps both.
    const config = makeConfig({ slack: { permissions: ["full-access"] } });
    const expanded = getExpanded(config);

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis).toHaveLength(2);
    // Both api_entries share the same permission name
    for (const api of expanded[0]!.apis) {
      expect(api.permissions!.map((p) => p.name)).toEqual(["full-access"]);
    }
  });

  it("should skip services with no agents", () => {
    const config = { version: "1.0" };
    expandServiceConfigs(config);
    // No error thrown
  });

  it("should skip already expanded services (array format)", () => {
    const config = {
      version: "1.0",
      agents: {
        myagent: {
          framework: "claude-code",
          experimental_services: [
            { name: "github", ref: "github", apis: [], placeholders: {} },
          ],
        },
      },
    };
    expandServiceConfigs(config);
    // Should not modify already-expanded array
    expect(Array.isArray(config.agents.myagent.experimental_services)).toBe(
      true,
    );
  });

  it("should not include description when service has none", () => {
    const config = makeConfig({ github: { permissions: "all" } });
    const expanded = getExpanded(config);

    expect(expanded[0]!.description).toBeUndefined();
  });

  it("should throw for unknown service ref", () => {
    const config = makeConfig({ "not-a-service": { permissions: "all" } });
    expect(() => expandServiceConfigs(config)).toThrow(
      'Cannot resolve service ref "not-a-service"',
    );
  });

  it("should throw for non-existent permission name", () => {
    const config = makeConfig({
      github: { permissions: ["does-not-exist"] },
    });
    expect(() => expandServiceConfigs(config)).toThrow(
      'Permission "does-not-exist" does not exist in service "github"',
    );
  });

  it("should validate all built-in service configs pass rule validation", () => {
    // Every built-in service with a service config should pass validation
    for (const type of connectorTypeSchema.options) {
      if (!getServiceConfig(type)) continue;
      const config = makeConfig({ [type]: { permissions: "all" } });
      expect(() => expandServiceConfigs(config)).not.toThrow();
    }
  });
});

describe("validateRule", () => {
  it("should accept valid rules", () => {
    expect(() =>
      validateRule("GET /repos/{owner}/{repo}", "p", "svc"),
    ).not.toThrow();
    expect(() =>
      validateRule("POST /chat.postMessage", "p", "svc"),
    ).not.toThrow();
    expect(() => validateRule("ANY /{path+}", "p", "svc")).not.toThrow();
    expect(() =>
      validateRule("DELETE /repos/{owner}/{repo}", "p", "svc"),
    ).not.toThrow();
    expect(() =>
      validateRule("PUT /repos/{owner}/{repo}/contents/{path+}", "p", "svc"),
    ).not.toThrow();
    expect(() =>
      validateRule("PATCH /repos/{owner}/{repo}/pulls/{number}", "p", "svc"),
    ).not.toThrow();
    expect(() => validateRule("GET /", "p", "svc")).not.toThrow();
  });

  it("should reject missing path", () => {
    expect(() => validateRule("GET", "read", "github")).toThrow(
      'must be "METHOD /path"',
    );
  });

  it("should reject empty string", () => {
    expect(() => validateRule("", "read", "github")).toThrow(
      'must be "METHOD /path"',
    );
  });

  it("should reject unknown method", () => {
    expect(() => validateRule("INVALID /foo", "read", "github")).toThrow(
      'unknown method "INVALID"',
    );
  });

  it("should reject lowercase method", () => {
    expect(() => validateRule("get /foo", "read", "github")).toThrow(
      "must be uppercase",
    );
  });

  it("should reject path with query string", () => {
    expect(() => validateRule("GET /foo?bar=1", "read", "github")).toThrow(
      "must not contain query string or fragment",
    );
  });

  it("should reject path with fragment", () => {
    expect(() => validateRule("GET /foo#section", "read", "github")).toThrow(
      "must not contain query string or fragment",
    );
  });

  it("should reject path without leading slash", () => {
    expect(() => validateRule("GET foo", "read", "github")).toThrow(
      'path must start with "/"',
    );
  });

  it("should reject {param+} not in last segment", () => {
    expect(() =>
      validateRule("GET /foo/{path+}/bar", "read", "github"),
    ).toThrow("{path+} must be the last segment");
  });

  it("should accept {param+} in last segment", () => {
    expect(() =>
      validateRule("GET /repos/{owner}/{path+}", "p", "svc"),
    ).not.toThrow();
  });

  it("should reject duplicate parameter names", () => {
    expect(() =>
      validateRule("GET /repos/{owner}/{owner}", "p", "svc"),
    ).toThrow('duplicate parameter name "{owner}"');
  });

  it("should reject empty parameter name", () => {
    expect(() => validateRule("GET /repos/{}", "p", "svc")).toThrow(
      "empty parameter name",
    );
  });

  it("should reject empty greedy parameter name", () => {
    expect(() => validateRule("GET /repos/{+}", "p", "svc")).toThrow(
      "empty parameter name",
    );
  });
});

describe("validateBaseUrl", () => {
  it("should accept valid URLs", () => {
    expect(() =>
      validateBaseUrl("https://api.github.com", "github"),
    ).not.toThrow();
    expect(() =>
      validateBaseUrl("https://slack.com/api", "slack"),
    ).not.toThrow();
    expect(() =>
      validateBaseUrl("https://us1.api.mailchimp.com/3.0", "mailchimp"),
    ).not.toThrow();
  });

  it("should reject invalid URLs", () => {
    expect(() => validateBaseUrl("not-a-url", "svc")).toThrow(
      "not a valid URL",
    );
  });

  it("should reject URLs with query string", () => {
    expect(() =>
      validateBaseUrl("https://api.example.com?key=val", "svc"),
    ).toThrow("must not contain query string");
  });

  it("should reject URLs with fragment", () => {
    expect(() =>
      validateBaseUrl("https://api.example.com#section", "svc"),
    ).toThrow("must not contain fragment");
  });
});
