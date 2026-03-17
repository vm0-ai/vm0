import { describe, it, expect, vi } from "vitest";
import type { ExpandedFirewallConfig } from "../firewalls";
import {
  expandFirewallConfigs,
  validateRule,
  validateBaseUrl,
} from "../firewall-expander";
import type { FetchFn } from "../../firewall-loader";

/** Helper to create a mock fetch function returning given body and status */
function mockFetch(body: string, status = 200, statusText = "OK"): FetchFn {
  return vi
    .fn<FetchFn>()
    .mockResolvedValue(new Response(body, { status, statusText }));
}

const GITHUB_YAML = `
name: github
description: GitHub API
placeholders:
  GITHUB_TOKEN: "gho_Vm0PlaceHolder0000000000000000000000"
apis:
  - base: https://api.github.com
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.GITHUB_TOKEN }}"
    permissions:
      - name: repo-read
        description: Read repository metadata
        rules:
          - GET /repos/{owner}/{repo}
          - GET /repos/{owner}/{repo}/branches
      - name: issues-read
        description: Read issues
        rules:
          - GET /repos/{owner}/{repo}/issues
      - name: issues-write
        description: Write issues
        rules:
          - POST /repos/{owner}/{repo}/issues
      - name: search
        description: Search
        rules:
          - GET /search/code
`;

const SLACK_YAML = `
name: slack
placeholders:
  SLACK_TOKEN: "xoxb-0000-0000-Vm0PlaceHolder0000000000"
apis:
  - base: https://slack.com/api
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.SLACK_TOKEN }}"
    permissions:
      - name: full-access
        rules:
          - ANY /{path+}
  - base: https://files.slack.com
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.SLACK_TOKEN }}"
    permissions:
      - name: full-access
        rules:
          - ANY /{path+}
`;

describe("expandFirewallConfigs", () => {
  function makeConfig(
    configs: Record<string, { permissions: string[] | "all" }>,
  ) {
    return {
      version: "1.0",
      agents: {
        myagent: {
          framework: "claude-code",
          experimental_firewalls: configs,
        },
      },
    };
  }

  async function getExpanded(
    config: ReturnType<typeof makeConfig>,
    fetchFn?: FetchFn,
  ) {
    await expandFirewallConfigs(config, fetchFn);
    return config.agents.myagent
      .experimental_firewalls as unknown as ExpandedFirewallConfig[];
  }

  /** Mock fetch that returns the right YAML based on URL */
  function mockMultiFetch(): FetchFn {
    return vi.fn<FetchFn>().mockImplementation((url: string) => {
      if (url.includes("/github/")) {
        return Promise.resolve(new Response(GITHUB_YAML, { status: 200 }));
      }
      if (url.includes("/slack/")) {
        return Promise.resolve(new Response(SLACK_YAML, { status: 200 }));
      }
      return Promise.resolve(
        new Response("Not Found", { status: 404, statusText: "Not Found" }),
      );
    });
  }

  it("should expand firewall with permissions: all", async () => {
    const config = makeConfig({ github: { permissions: "all" } });
    const expanded = await getExpanded(config, mockFetch(GITHUB_YAML));

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.name).toBe("github");
    expect(expanded[0]!.ref).toBe("github");
    expect(expanded[0]!.apis).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.base).toBe("https://api.github.com");
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => p.name);
    expect(permNames).toContain("repo-read");
    expect(permNames).toContain("issues-read");
    expect(permNames).toContain("search");
  });

  it("should expand firewall with specific permissions", async () => {
    const config = makeConfig({
      github: { permissions: ["issues-read", "issues-write"] },
    });
    const expanded = await getExpanded(config, mockFetch(GITHUB_YAML));

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(2);
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => p.name);
    expect(permNames).toContain("issues-read");
    expect(permNames).toContain("issues-write");
  });

  it("should include placeholders when config has them", async () => {
    const config = makeConfig({ github: { permissions: "all" } });
    const expanded = await getExpanded(config, mockFetch(GITHUB_YAML));

    expect(expanded[0]!.placeholders).toEqual({
      GITHUB_TOKEN: "gho_Vm0PlaceHolder0000000000000000000000",
    });
  });

  it("should expand multiple firewall configs in parallel", async () => {
    const config = makeConfig({
      github: { permissions: "all" },
      slack: { permissions: "all" },
    });
    const expanded = await getExpanded(config, mockMultiFetch());

    expect(expanded).toHaveLength(2);
    const names = expanded.map((s) => s.name);
    expect(names).toContain("github");
    expect(names).toContain("slack");
  });

  it("should keep all api_entries when shared permission is selected", async () => {
    const config = makeConfig({ slack: { permissions: ["full-access"] } });
    const expanded = await getExpanded(config, mockFetch(SLACK_YAML));

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis).toHaveLength(2);
    for (const api of expanded[0]!.apis) {
      expect(api.permissions!.map((p) => p.name)).toEqual(["full-access"]);
    }
  });

  it("should skip configs with no agents", async () => {
    const config = { version: "1.0" };
    await expandFirewallConfigs(config);
  });

  it("should skip already expanded configs (array format)", async () => {
    const config = {
      version: "1.0",
      agents: {
        myagent: {
          framework: "claude-code",
          experimental_firewalls: [
            { name: "github", ref: "github", apis: [], placeholders: {} },
          ],
        },
      },
    };
    await expandFirewallConfigs(config);
    expect(Array.isArray(config.agents.myagent.experimental_firewalls)).toBe(
      true,
    );
  });

  it("should include description when config has it", async () => {
    const config = makeConfig({ github: { permissions: "all" } });
    const expanded = await getExpanded(config, mockFetch(GITHUB_YAML));

    expect(expanded[0]!.description).toBe("GitHub API");
  });

  it("should throw for non-existent permission name", async () => {
    const config = makeConfig({
      github: { permissions: ["does-not-exist"] },
    });
    await expect(
      expandFirewallConfigs(config, mockFetch(GITHUB_YAML)),
    ).rejects.toThrow(
      'Permission "does-not-exist" does not exist in firewall "github"',
    );
  });

  it("should throw when GitHub fetch fails", async () => {
    const config = makeConfig({
      "nonexistent-api": { permissions: "all" },
    });
    await expect(
      expandFirewallConfigs(config, mockFetch("Not Found", 404, "Not Found")),
    ).rejects.toThrow('Failed to fetch firewall config for "nonexistent-api"');
  });

  it("should filter permissions on fetched config", async () => {
    const config = makeConfig({ github: { permissions: ["repo-read"] } });
    const expanded = await getExpanded(config, mockFetch(GITHUB_YAML));

    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions![0]!.name).toBe("repo-read");
  });

  it("should support full GitHub URL as ref", async () => {
    const yamlContent = `
name: my-firewall
apis:
  - base: https://api.example.com
    auth:
      headers:
        X-Api-Key: "\${{ secrets.EXAMPLE_KEY }}"
    permissions:
      - name: full-access
        rules:
          - ANY /{path+}
`;

    const fetchFn = mockFetch(yamlContent);

    const config = makeConfig({
      "https://github.com/acme/firewalls/tree/main/my-firewall": {
        permissions: "all",
      },
    });
    const expanded = await getExpanded(config, fetchFn);

    expect(expanded[0]!.name).toBe("my-firewall");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme/firewalls/main/my-firewall/firewall.yaml",
    );
  });
});

describe("validateRule", () => {
  it("should accept valid rules", () => {
    expect(() =>
      validateRule("GET /repos/{owner}/{repo}", "p", "fw"),
    ).not.toThrow();
    expect(() =>
      validateRule("POST /chat.postMessage", "p", "fw"),
    ).not.toThrow();
    expect(() => validateRule("ANY /{path+}", "p", "fw")).not.toThrow();
    expect(() =>
      validateRule("DELETE /repos/{owner}/{repo}", "p", "fw"),
    ).not.toThrow();
    expect(() =>
      validateRule("PUT /repos/{owner}/{repo}/contents/{path+}", "p", "fw"),
    ).not.toThrow();
    expect(() =>
      validateRule("PATCH /repos/{owner}/{repo}/pulls/{number}", "p", "fw"),
    ).not.toThrow();
    expect(() => validateRule("GET /", "p", "fw")).not.toThrow();
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
      validateRule("GET /repos/{owner}/{path+}", "p", "fw"),
    ).not.toThrow();
  });

  it("should accept {param*} in last segment", () => {
    expect(() => validateRule("ANY /{path*}", "p", "fw")).not.toThrow();
    expect(() =>
      validateRule("GET /repos/{owner}/{path*}", "p", "fw"),
    ).not.toThrow();
  });

  it("should reject {param*} not in last segment", () => {
    expect(() =>
      validateRule("GET /foo/{path*}/bar", "read", "github"),
    ).toThrow("{path*} must be the last segment");
  });

  it("should reject duplicate parameter names", () => {
    expect(() => validateRule("GET /repos/{owner}/{owner}", "p", "fw")).toThrow(
      'duplicate parameter name "{owner}"',
    );
  });

  it("should reject empty parameter name", () => {
    expect(() => validateRule("GET /repos/{}", "p", "fw")).toThrow(
      "empty parameter name",
    );
  });

  it("should reject empty greedy parameter name", () => {
    expect(() => validateRule("GET /repos/{+}", "p", "fw")).toThrow(
      "empty parameter name",
    );
  });

  it("should reject empty star parameter name", () => {
    expect(() => validateRule("GET /repos/{*}", "p", "fw")).toThrow(
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
    expect(() => validateBaseUrl("not-a-url", "fw")).toThrow("not a valid URL");
  });

  it("should reject URLs with query string", () => {
    expect(() =>
      validateBaseUrl("https://api.example.com?key=val", "fw"),
    ).toThrow("must not contain query string");
  });

  it("should reject URLs with fragment", () => {
    expect(() =>
      validateBaseUrl("https://api.example.com#section", "fw"),
    ).toThrow("must not contain fragment");
  });
});
