import { describe, it, expect, vi } from "vitest";
import {
  validateBaseUrl,
  hasBaseUrlParams,
  hasBaseUrlVars,
  resolveFirewallBaseUrlVars,
} from "../firewalls";
import { resolveFirewallSelections, validateRule } from "../firewall-expander";
import type { FetchFn } from "../../firewall-loader";

/** Helper to create a mock fetch function returning given body and status */
function mockFetch(body: string, status = 200, statusText = "OK"): FetchFn {
  return vi
    .fn<FetchFn>()
    .mockResolvedValue(new Response(body, { status, statusText }));
}

const CUSTOM_GIT_YAML = `
name: custom-git
description: Custom Git API
placeholders:
  GIT_TOKEN: "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"
apis:
  - base: https://api.custom-git.com
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.GIT_TOKEN }}"
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

const CUSTOM_CHAT_YAML = `
name: custom-chat
placeholders:
  CHAT_TOKEN: "xoxb-100100100100-1001001001001-CoffeeSaf"
apis:
  - base: https://custom-chat.com/api
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.CHAT_TOKEN }}"
    permissions:
      - name: full-access
        rules:
          - ANY /{path+}
  - base: https://files.custom-chat.com
    auth:
      headers:
        Authorization: "Bearer \${{ secrets.CHAT_TOKEN }}"
    permissions:
      - name: full-access
        rules:
          - ANY /{path+}
`;

describe("resolveFirewallSelections", () => {
  /** Mock fetch that returns the right YAML based on URL */
  function mockMultiFetch(): FetchFn {
    return vi.fn<FetchFn>().mockImplementation((url: string) => {
      if (url.includes("/custom-git/")) {
        return Promise.resolve(new Response(CUSTOM_GIT_YAML, { status: 200 }));
      }
      if (url.includes("/custom-chat/")) {
        return Promise.resolve(new Response(CUSTOM_CHAT_YAML, { status: 200 }));
      }
      return Promise.resolve(
        new Response("Not Found", { status: 404, statusText: "Not Found" }),
      );
    });
  }

  it("should resolve firewall with permissions: all", async () => {
    const expanded = await resolveFirewallSelections(
      { "custom-git": { permissions: "all" } },
      mockFetch(CUSTOM_GIT_YAML),
    );

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.name).toBe("custom-git");
    expect(expanded[0]!.ref).toBe("custom-git");
    expect(expanded[0]!.apis).toHaveLength(1);
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => {
      return p.name;
    });
    expect(permNames).toContain("repo-read");
    expect(permNames).toContain("issues-read");
    expect(permNames).toContain("search");
  });

  it("should resolve firewall with specific permissions", async () => {
    const expanded = await resolveFirewallSelections(
      { "custom-git": { permissions: ["issues-read", "issues-write"] } },
      mockFetch(CUSTOM_GIT_YAML),
    );

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(2);
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => {
      return p.name;
    });
    expect(permNames).toContain("issues-read");
    expect(permNames).toContain("issues-write");
  });

  it("should include placeholders and description when config has them", async () => {
    const expanded = await resolveFirewallSelections(
      { "custom-git": { permissions: "all" } },
      mockFetch(CUSTOM_GIT_YAML),
    );

    expect(expanded[0]!.placeholders).toEqual({
      GIT_TOKEN: "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",
    });
    expect(expanded[0]!.description).toBe("Custom Git API");
  });

  it("should resolve multiple firewalls in parallel", async () => {
    const expanded = await resolveFirewallSelections(
      {
        "custom-git": { permissions: "all" },
        "custom-chat": { permissions: "all" },
      },
      mockMultiFetch(),
    );

    expect(expanded).toHaveLength(2);
    const names = expanded.map((s) => {
      return s.name;
    });
    expect(names).toContain("custom-git");
    expect(names).toContain("custom-chat");
  });

  it("should return empty array for empty selections", async () => {
    const expanded = await resolveFirewallSelections({});
    expect(expanded).toEqual([]);
  });

  it("should throw for non-existent permission name", async () => {
    await expect(
      resolveFirewallSelections(
        { "custom-git": { permissions: ["does-not-exist"] } },
        mockFetch(CUSTOM_GIT_YAML),
      ),
    ).rejects.toThrow(
      'Permission "does-not-exist" does not exist in firewall "custom-git"',
    );
  });

  it("should throw when fetch fails", async () => {
    await expect(
      resolveFirewallSelections(
        { "nonexistent-api": { permissions: "all" } },
        mockFetch("Not Found", 404, "Not Found"),
      ),
    ).rejects.toThrow('Failed to fetch firewall config for "nonexistent-api"');
  });

  it("should filter permissions and keep only selected ones", async () => {
    const expanded = await resolveFirewallSelections(
      { "custom-git": { permissions: ["repo-read"] } },
      mockFetch(CUSTOM_GIT_YAML),
    );

    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions![0]!.name).toBe("repo-read");
  });

  it("should keep all api_entries when shared permission is selected", async () => {
    const expanded = await resolveFirewallSelections(
      { "custom-chat": { permissions: ["full-access"] } },
      mockFetch(CUSTOM_CHAT_YAML),
    );

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis).toHaveLength(2);
    for (const api of expanded[0]!.apis) {
      expect(
        api.permissions!.map((p) => {
          return p.name;
        }),
      ).toEqual(["full-access"]);
    }
  });

  it("should resolve builtin slack firewall without fetch", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const expanded = await resolveFirewallSelections(
      { slack: { permissions: "all" } },
      fetchFn,
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.name).toBe("slack");
    expect(expanded[0]!.ref).toBe("slack");
    expect(expanded[0]!.apis.length).toBeGreaterThan(0);
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
    const expanded = await resolveFirewallSelections(
      {
        "https://github.com/acme/firewalls/tree/main/my-firewall": {
          permissions: "all",
        },
      },
      fetchFn,
    );

    expect(expanded[0]!.name).toBe("my-firewall");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme/firewalls/main/my-firewall/firewall.yaml",
    );
  });
});

describe("validateRule", () => {
  it("should accept valid rules", () => {
    expect(() => {
      return validateRule("GET /repos/{owner}/{repo}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("POST /chat.postMessage", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("ANY /{path+}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("DELETE /repos/{owner}/{repo}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule(
        "PUT /repos/{owner}/{repo}/contents/{path+}",
        "p",
        "fw",
      );
    }).not.toThrow();
    expect(() => {
      return validateRule(
        "PATCH /repos/{owner}/{repo}/pulls/{number}",
        "p",
        "fw",
      );
    }).not.toThrow();
    expect(() => {
      return validateRule("GET /", "p", "fw");
    }).not.toThrow();
  });

  it("should reject missing path", () => {
    expect(() => {
      return validateRule("GET", "read", "github");
    }).toThrow('must be "METHOD /path"');
  });

  it("should reject empty string", () => {
    expect(() => {
      return validateRule("", "read", "github");
    }).toThrow('must be "METHOD /path"');
  });

  it("should reject unknown method", () => {
    expect(() => {
      return validateRule("INVALID /foo", "read", "github");
    }).toThrow('unknown method "INVALID"');
  });

  it("should reject lowercase method", () => {
    expect(() => {
      return validateRule("get /foo", "read", "github");
    }).toThrow("must be uppercase");
  });

  it("should reject path with query string", () => {
    expect(() => {
      return validateRule("GET /foo?bar=1", "read", "github");
    }).toThrow("must not contain query string or fragment");
  });

  it("should reject path with fragment", () => {
    expect(() => {
      return validateRule("GET /foo#section", "read", "github");
    }).toThrow("must not contain query string or fragment");
  });

  it("should reject path without leading slash", () => {
    expect(() => {
      return validateRule("GET foo", "read", "github");
    }).toThrow('path must start with "/"');
  });

  it("should reject {param+} not in last segment", () => {
    expect(() => {
      return validateRule("GET /foo/{path+}/bar", "read", "github");
    }).toThrow("{path+} must be the last segment");
  });

  it("should accept {param+} in last segment", () => {
    expect(() => {
      return validateRule("GET /repos/{owner}/{path+}", "p", "fw");
    }).not.toThrow();
  });

  it("should accept {param*} in last segment", () => {
    expect(() => {
      return validateRule("ANY /{path*}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("GET /repos/{owner}/{path*}", "p", "fw");
    }).not.toThrow();
  });

  it("should reject {param*} not in last segment", () => {
    expect(() => {
      return validateRule("GET /foo/{path*}/bar", "read", "github");
    }).toThrow("{path*} must be the last segment");
  });

  it("should reject duplicate parameter names", () => {
    expect(() => {
      return validateRule("GET /repos/{owner}/{owner}", "p", "fw");
    }).toThrow('duplicate parameter name "{owner}"');
  });

  it("should reject empty parameter name", () => {
    expect(() => {
      return validateRule("GET /repos/{}", "p", "fw");
    }).toThrow("empty parameter name");
  });

  it("should reject empty greedy parameter name", () => {
    expect(() => {
      return validateRule("GET /repos/{+}", "p", "fw");
    }).toThrow("empty parameter name");
  });

  it("should reject empty star parameter name", () => {
    expect(() => {
      return validateRule("GET /repos/{*}", "p", "fw");
    }).toThrow("empty parameter name");
  });

  // GraphQL rules
  it("should accept GraphQL type:query rule", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL type:query", "p", "fw");
    }).not.toThrow();
  });

  it("should accept GraphQL type:mutation rule", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL type:mutation", "p", "fw");
    }).not.toThrow();
  });

  it("should accept GraphQL type + operationName rule", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:mutation operationName:issueCreate",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept GraphQL operationName only rule", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL operationName:issueCreate",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept GraphQL operationName wildcard rule", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL operationName:issue*",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept GraphQL operationName catch-all wildcard", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL operationName:*", "p", "fw");
    }).not.toThrow();
  });

  it("should accept GraphQL type:subscription rule", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL type:subscription", "p", "fw");
    }).not.toThrow();
  });

  it("should reject bare GraphQL keyword with no modifiers", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL", "p", "fw");
    }).toThrow("requires at least one modifier");
  });

  it("should reject invalid GraphQL type", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL type:fragment", "p", "fw");
    }).toThrow('type must be "query", "mutation", or "subscription"');
  });

  it("should reject empty GraphQL operationName", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL operationName:", "p", "fw");
    }).toThrow("empty GraphQL operationName");
  });

  it("should reject unknown GraphQL modifier", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL foo:bar", "p", "fw");
    }).toThrow("unknown GraphQL modifier");
  });

  it("should reject invalid operationName pattern", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL operationName:issue-create",
        "p",
        "fw",
      );
    }).toThrow("invalid GraphQL operationName pattern");
  });

  it("should validate path in GraphQL rule", () => {
    expect(() => {
      return validateRule("POST noslash GraphQL type:query", "p", "fw");
    }).toThrow("path must start with");
  });

  it("should accept GraphQL field: modifier", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:mutation field:createIssue",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept GraphQL field wildcard", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:mutation field:create*",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept GraphQL field-only modifier", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL field:createIssue", "p", "fw");
    }).not.toThrow();
  });

  it("should reject empty GraphQL field name", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL field:", "p", "fw");
    }).toThrow("empty GraphQL field name");
  });

  it("should reject invalid GraphQL field pattern", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL field:create-issue",
        "p",
        "fw",
      );
    }).toThrow("invalid GraphQL field pattern");
  });

  it("should accept GraphQL field with underscore prefix", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL field:__typename", "p", "fw");
    }).not.toThrow();
  });

  it("should accept GraphQL field with numbers", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL field:field123", "p", "fw");
    }).not.toThrow();
  });

  it("should accept GraphQL field catch-all wildcard", () => {
    expect(() => {
      return validateRule("POST /graphql GraphQL field:*", "p", "fw");
    }).not.toThrow();
  });

  it("should accept all three modifiers together", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:mutation operationName:IssueCreate field:createIssue",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept dot-separated field paths", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:query field:repository.issues",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept deeply nested field paths", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:query field:repository.issues.nodes",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should accept dot-separated field path with wildcard", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:query field:repository.*",
        "p",
        "fw",
      );
    }).not.toThrow();
  });

  it("should reject field path with trailing dot", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:query field:repository.",
        "p",
        "fw",
      );
    }).toThrow("invalid GraphQL field pattern");
  });

  it("should reject field path with leading dot", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:query field:.issues",
        "p",
        "fw",
      );
    }).toThrow("invalid GraphQL field pattern");
  });

  it("should reject field path with consecutive dots", () => {
    expect(() => {
      return validateRule(
        "POST /graphql GraphQL type:query field:repository..issues",
        "p",
        "fw",
      );
    }).toThrow("invalid GraphQL field pattern");
  });
});

describe("validateBaseUrl", () => {
  it("should accept valid URLs", () => {
    expect(() => {
      return validateBaseUrl("https://api.github.com", "github");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://slack.com/api", "slack");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://us1.api.mailchimp.com/3.0", "mailchimp");
    }).not.toThrow();
  });

  it("should reject invalid URLs", () => {
    expect(() => {
      return validateBaseUrl("not-a-url", "fw");
    }).toThrow("not a valid URL");
  });

  it("should reject URLs with query string", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com?key=val", "fw");
    }).toThrow("must not contain query string");
  });

  it("should reject URLs with fragment", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com#section", "fw");
    }).toThrow("must not contain fragment");
  });

  it("should skip template base URLs", () => {
    expect(() => {
      return validateBaseUrl(
        "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
        "zendesk",
      );
    }).not.toThrow();
  });

  it("should accept base URL with single host param", () => {
    expect(() => {
      return validateBaseUrl("https://{subdomain}.zendesk.com", "zendesk");
    }).not.toThrow();
  });

  it("should accept base URL with greedy host param in first position", () => {
    expect(() => {
      return validateBaseUrl("https://{sub+}.example.com", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://{sub*}.example.com", "fw");
    }).not.toThrow();
  });

  it("should accept base URL with single path param", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1/{org}", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1/{org}/projects", "fw");
    }).not.toThrow();
  });

  it("should accept base URL with host and path params", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com/v1/{org}", "fw");
    }).not.toThrow();
  });

  it("should reject greedy host param not in first position", () => {
    expect(() => {
      return validateBaseUrl("https://api.{sub+}.example.com", "fw");
    }).toThrow("{sub+} must be the first host segment");
    expect(() => {
      return validateBaseUrl("https://api.{sub*}.example.com", "fw");
    }).toThrow("{sub*} must be the first host segment");
  });

  it("should reject greedy path param in base URL", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/{path+}", "fw");
    }).toThrow("greedy parameter {path+} is not allowed in base URL path");
    expect(() => {
      return validateBaseUrl("https://api.example.com/{path*}", "fw");
    }).toThrow("greedy parameter {path*} is not allowed in base URL path");
  });

  it("should reject host with no static segments", () => {
    expect(() => {
      return validateBaseUrl("https://{a}.{b}", "fw");
    }).toThrow("must have at least one static segment");
  });

  it("should reject empty param name in host", () => {
    expect(() => {
      return validateBaseUrl("https://{}.example.com", "fw");
    }).toThrow("empty parameter name in host");
  });

  it("should reject empty param name in path", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/{}", "fw");
    }).toThrow("empty parameter name in path");
  });

  it("should reject duplicate param names in host", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.{sub}.example.com", "fw");
    }).toThrow('duplicate parameter name "{sub}" in host');
  });

  it("should reject duplicate param names across host and path", () => {
    expect(() => {
      return validateBaseUrl("https://{org}.example.com/{org}", "fw");
    }).toThrow('duplicate parameter name "{org}"');
  });

  it("should reject query string in parameterized base URL", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com?key=val", "fw");
    }).toThrow("must not contain query string");
  });

  it("should reject fragment in parameterized base URL", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com#section", "fw");
    }).toThrow("must not contain fragment");
  });

  it("should reject param in scheme", () => {
    expect(() => {
      return validateBaseUrl("{proto}://api.example.com", "fw");
    }).toThrow("scheme must not contain parameters");
  });

  it("should reject partial param in host segment", () => {
    expect(() => {
      return validateBaseUrl("https://api-{version}.example.com", "fw");
    }).toThrow('host segment "api-{version}" contains "{"');
  });

  it("should reject partial param in path segment", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1-{version}", "fw");
    }).toThrow('path segment "v1-{version}" contains "{"');
  });
});

describe("hasBaseUrlParams", () => {
  it("returns true for host params", () => {
    expect(hasBaseUrlParams("https://{sub}.zendesk.com")).toBe(true);
  });

  it("returns true for path params", () => {
    expect(hasBaseUrlParams("https://api.example.com/v1/{org}")).toBe(true);
  });

  it("returns false for static URLs", () => {
    expect(hasBaseUrlParams("https://api.github.com")).toBe(false);
  });

  it("returns false for template vars", () => {
    expect(hasBaseUrlParams("https://${{ vars.X }}.example.com")).toBe(false);
  });

  it("returns true when both template vars and params present", () => {
    expect(hasBaseUrlParams("https://${{ vars.X }}.{region}.example.com")).toBe(
      true,
    );
  });

  it("handles adversarial input with many ${{ without closing }}", () => {
    const adversarial = "https://" + "${{".repeat(1000) + ".example.com";
    expect(hasBaseUrlParams(adversarial)).toBe(false);
  });
});

describe("hasBaseUrlVars", () => {
  it("returns true for template base URLs", () => {
    expect(
      hasBaseUrlVars("https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com"),
    ).toBe(true);
  });

  it("returns false for static base URLs", () => {
    expect(hasBaseUrlVars("https://api.github.com")).toBe(false);
  });

  it("returns true for multiple vars", () => {
    expect(
      hasBaseUrlVars("https://${{ vars.A }}.${{ vars.B }}.example.com"),
    ).toBe(true);
  });
});

describe("resolveFirewallBaseUrlVars", () => {
  const zendeskFirewall = {
    name: "zendesk",
    ref: "zendesk",
    apis: [
      {
        base: "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.ZENDESK_API_TOKEN }}",
          },
        },
      },
    ],
  };

  const staticFirewall = {
    name: "github",
    ref: "github",
    apis: [
      {
        base: "https://api.github.com",
        auth: {
          headers: { Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}" },
        },
      },
    ],
  };

  it("resolves template base URL with provided vars", () => {
    const result = resolveFirewallBaseUrlVars([zendeskFirewall], {
      ZENDESK_SUBDOMAIN: "mycompany",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://mycompany.zendesk.com");
  });

  it("leaves static base URLs unchanged", () => {
    const result = resolveFirewallBaseUrlVars([staticFirewall], {
      ZENDESK_SUBDOMAIN: "mycompany",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://api.github.com");
  });

  it("resolves mixed static and template firewalls", () => {
    const result = resolveFirewallBaseUrlVars(
      [staticFirewall, zendeskFirewall],
      { ZENDESK_SUBDOMAIN: "acme" },
    );
    expect(result[0]!.apis[0]!.base).toBe("https://api.github.com");
    expect(result[1]!.apis[0]!.base).toBe("https://acme.zendesk.com");
  });

  it("throws when required variable is missing", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([zendeskFirewall], {});
    }).toThrow('requires variable "ZENDESK_SUBDOMAIN"');
  });

  it("throws when vars is undefined", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([zendeskFirewall], undefined);
    }).toThrow('requires variable "ZENDESK_SUBDOMAIN"');
  });

  it("validates resolved URL is well-formed", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([zendeskFirewall], {
        ZENDESK_SUBDOMAIN: "bad value with spaces",
      });
    }).toThrow("not a valid URL");
  });

  it("preserves auth headers unchanged", () => {
    const result = resolveFirewallBaseUrlVars([zendeskFirewall], {
      ZENDESK_SUBDOMAIN: "mycompany",
    });
    expect(result[0]!.apis[0]!.auth.headers.Authorization).toBe(
      "Bearer ${{ secrets.ZENDESK_API_TOKEN }}",
    );
  });

  it("returns empty array for empty input", () => {
    expect(resolveFirewallBaseUrlVars([], undefined)).toEqual([]);
  });
});
