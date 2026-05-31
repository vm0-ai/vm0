import { describe, it, expect } from "vitest";
import {
  matchFirewallHost,
  matchFirewallPath,
  matchFirewallPathPrefix,
  findMatchingPermissions,
} from "../firewall-rule-matcher";
import type { FirewallConfig } from "../firewall-types";

describe("matchFirewallPath", () => {
  it("matches exact literal path", () => {
    expect(matchFirewallPath("/api/v1/users", "/api/v1/users")).toEqual({});
  });

  it("matches single segment params", () => {
    expect(
      matchFirewallPath(
        "/repos/myorg/myrepo/pulls",
        "/repos/{owner}/{repo}/pulls",
      ),
    ).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("matches greedy + (one or more)", () => {
    expect(
      matchFirewallPath(
        "/repos/a/b/git/ref/heads/main",
        "/repos/{owner}/{repo}/git/{rest+}",
      ),
    ).toEqual({ owner: "a", repo: "b", rest: "ref/heads/main" });
  });

  it("fails greedy + when no segments remain", () => {
    expect(
      matchFirewallPath("/repos/a/b/git", "/repos/{owner}/{repo}/git/{rest+}"),
    ).toBeNull();
  });

  it("fails greedy + when only empty segments remain", () => {
    expect(
      matchFirewallPath("/repos/a/b/git/", "/repos/{owner}/{repo}/git/{rest+}"),
    ).toBeNull();
    expect(
      matchFirewallPath(
        "/repos/a/b/git//",
        "/repos/{owner}/{repo}/git/{rest+}",
      ),
    ).toBeNull();
  });

  it("preserves empty segments before non-empty greedy + rest", () => {
    expect(
      matchFirewallPath(
        "/repos/a/b/git//heads/main",
        "/repos/{owner}/{repo}/git/{rest+}",
      ),
    ).toEqual({ owner: "a", repo: "b", rest: "/heads/main" });
  });

  it("matches greedy * (zero or more) with segments", () => {
    expect(matchFirewallPath("/anything/here", "/{path*}")).toEqual({
      path: "anything/here",
    });
  });

  it("matches greedy * with zero segments", () => {
    expect(matchFirewallPath("/", "/{path*}")).toEqual({ path: "" });
  });

  it("returns null on literal mismatch", () => {
    expect(matchFirewallPath("/api/v2/users", "/api/v1/users")).toBeNull();
  });

  it("returns null when path is too short", () => {
    expect(
      matchFirewallPath("/repos/myorg", "/repos/{owner}/{repo}/pulls"),
    ).toBeNull();
  });

  it("returns null when path is too long (no greedy)", () => {
    expect(
      matchFirewallPath(
        "/repos/myorg/myrepo/pulls/123",
        "/repos/{owner}/{repo}/pulls",
      ),
    ).toBeNull();
  });

  it("returns null on empty path vs non-empty pattern", () => {
    expect(matchFirewallPath("/", "/api/v1")).toBeNull();
  });

  it("treats trailing slashes as distinct path segments", () => {
    expect(matchFirewallPath("/api/v1/users/", "/api/v1/users")).toBeNull();
  });

  it("rejects empty path segments for single-segment params", () => {
    expect(matchFirewallPath("/repos//myrepo", "/repos/{owner}")).toBeNull();
    expect(matchFirewallPath("//repos/myorg", "/repos/{owner}")).toBeNull();
    expect(matchFirewallPath("/repos/myorg/", "/repos/{owner}")).toBeNull();
  });

  it("can match explicitly empty path segments", () => {
    expect(matchFirewallPath("/repos//myorg", "/repos//{owner}")).toEqual({
      owner: "myorg",
    });
  });

  it("handles multiple params in a row", () => {
    expect(
      matchFirewallPath(
        "/orgs/acme/insights/api/route-stats/user/42",
        "/orgs/{org}/insights/api/route-stats/{actor_type}/{actor_id}",
      ),
    ).toEqual({ org: "acme", actor_type: "user", actor_id: "42" });
  });
});

describe("matchFirewallHost", () => {
  it("matches host params case-insensitively", () => {
    expect(
      matchFirewallHost("ETH.G.ALCHEMY.COM", "{network}.g.alchemy.com"),
    ).toEqual({
      network: "eth",
    });
  });

  it("matches mixed host params case-insensitively", () => {
    expect(
      matchFirewallHost("API-US.EXAMPLE.COM", "api-{region}.example.com"),
    ).toEqual({
      region: "us",
    });
  });

  it("matches leading greedy host params", () => {
    expect(
      matchFirewallHost("foo.bar.bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toEqual({ deployment: "foo.bar" });
  });

  it("requires a non-empty leading host for plus greedy params", () => {
    expect(
      matchFirewallHost("bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toBeNull();
  });

  it("allows an empty leading host for star greedy params", () => {
    expect(matchFirewallHost("bentoml.ai", "{deployment*}.bentoml.ai")).toEqual(
      { deployment: "" },
    );
  });

  it("rejects non-leading greedy host params", () => {
    expect(
      matchFirewallHost("foo.bar.example.com", "foo.{deployment+}.com"),
    ).toBeNull();
  });

  it("preserves non-default ports in host matching", () => {
    expect(
      matchFirewallHost("api.example.com:8443", "api.example.com:8443"),
    ).toEqual({});
    expect(
      matchFirewallHost("api.example.com:9443", "api.example.com:8443"),
    ).toBeNull();
  });
});

describe("matchFirewallPathPrefix", () => {
  it("returns the full path for a root base prefix", () => {
    expect(matchFirewallPathPrefix("/v2/demo", "/")).toBe("/v2/demo");
  });

  it("returns slash when the path exactly matches the base prefix", () => {
    expect(matchFirewallPathPrefix("/api/v1", "/api/v1")).toBe("/");
  });

  it("returns relative path after literal base prefix", () => {
    expect(matchFirewallPathPrefix("/api/v1/users/123", "/api/v1")).toBe(
      "/users/123",
    );
  });

  it("returns relative path after parameterized base prefix", () => {
    expect(
      matchFirewallPathPrefix("/owner/repo/main/README.md", "/{owner}/{repo}"),
    ).toBe("/main/README.md");
  });

  it("matches mixed path segments in base prefixes", () => {
    expect(
      matchFirewallPathPrefix(
        "/owner/repo.git/info/refs",
        "/{owner}/{repo}.git",
      ),
    ).toBe("/info/refs");
  });

  it("keeps base boundary strict", () => {
    expect(matchFirewallPathPrefix("/apiary/users", "/api")).toBeNull();
  });

  it("rejects non-terminal greedy path params", () => {
    expect(
      matchFirewallPathPrefix("/api/a/b/tail", "/api/{rest+}/tail"),
    ).toBeNull();
  });

  it("requires plus greedy path params to consume a non-empty segment", () => {
    expect(matchFirewallPathPrefix("/api", "/api/{rest+}")).toBeNull();
    expect(matchFirewallPathPrefix("/api/", "/api/{rest+}")).toBeNull();
  });

  it("allows star greedy path params to consume zero segments", () => {
    expect(matchFirewallPathPrefix("/api", "/api/{rest*}")).toBe("/");
    expect(matchFirewallPathPrefix("/api/users/123", "/api/{rest*}")).toBe("/");
  });
});

describe("findMatchingPermissions", () => {
  const config: FirewallConfig = {
    name: "test-firewall",
    apis: [
      {
        base: "https://api.example.com",
        auth: { headers: { Authorization: "Bearer token" } },
        permissions: [
          {
            name: "repos:read",
            rules: [
              "GET /repos/{owner}/{repo}",
              "GET /repos/{owner}/{repo}/pulls",
            ],
          },
          {
            name: "repos:write",
            rules: ["POST /repos/{owner}/{repo}/pulls"],
          },
          {
            name: "issues:read",
            rules: ["GET /repos/{owner}/{repo}/issues"],
          },
        ],
      },
    ],
  };

  it("finds matching permission for GET request", () => {
    expect(
      findMatchingPermissions("GET", "/repos/myorg/myrepo/pulls", config),
    ).toEqual(["repos:read"]);
  });

  it("finds matching permission for POST request", () => {
    expect(
      findMatchingPermissions("POST", "/repos/myorg/myrepo/pulls", config),
    ).toEqual(["repos:write"]);
  });

  it("returns empty array when method does not match", () => {
    expect(
      findMatchingPermissions("DELETE", "/repos/myorg/myrepo/pulls", config),
    ).toEqual([]);
  });

  it("returns empty array when path does not match", () => {
    expect(
      findMatchingPermissions("GET", "/repos/myorg/myrepo/comments", config),
    ).toEqual([]);
  });

  it("handles case-insensitive method matching", () => {
    expect(
      findMatchingPermissions("get", "/repos/myorg/myrepo/pulls", config),
    ).toEqual(["repos:read"]);
  });

  it("matches ANY method rule", () => {
    const anyConfig: FirewallConfig = {
      name: "any-test",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "full-access", rules: ["ANY /{path*}"] }],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/anything/here", anyConfig)).toEqual(
      ["full-access"],
    );
    expect(findMatchingPermissions("POST", "/other", anyConfig)).toEqual([
      "full-access",
    ]);
  });

  it("returns only the most-specific permission when rules overlap", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "specific", rules: ["GET /api/users"] },
            { name: "catchall", rules: ["ANY /{path*}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["specific"],
    );
  });

  it("returns multiple permissions when best-specificity rules tie", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "read", rules: ["GET /api/users"] },
            { name: "audit", rules: ["ANY /api/users"] },
            { name: "catchall", rules: ["ANY /{path*}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["read", "audit"],
    );
  });

  it("considers later rules in the same permission for specificity", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            {
              name: "read",
              rules: ["ANY /{path*}", "GET /api/users"],
            },
            { name: "catchall", rules: ["ANY /{path*}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["read"],
    );
  });

  it("uses mixed segment specificity before plain params", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "plain", rules: ["GET /files/{id}"] },
            { name: "mixed", rules: ["GET /files/file-{id}"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/files/file-123", overlapConfig),
    ).toEqual(["mixed"]);
  });

  it("uses plain params before greedy params", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "greedy", rules: ["GET /files/{rest+}"] },
            { name: "plain", rules: ["GET /files/{id}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/files/123", overlapConfig)).toEqual(
      ["plain"],
    );
  });

  it("uses plus greedy params before star greedy params", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "star", rules: ["GET /files/{rest*}"] },
            { name: "plus", rules: ["GET /files/{rest+}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/files/123", overlapConfig)).toEqual(
      ["plus"],
    );
  });

  it("counts Unicode code points for literal-char specificity", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "emoji-prefix", rules: ["GET /files/😀{id}"] },
            { name: "ascii-suffix", rules: ["GET /files/{id}ab"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/files/😀xab", overlapConfig),
    ).toEqual(["ascii-suffix"]);
  });

  it("does not compare path specificity across API entries", () => {
    const multiApi: FirewallConfig = {
      name: "multi",
      apis: [
        {
          base: "https://api1.example.com",
          auth: { headers: {} },
          permissions: [{ name: "catchall", rules: ["GET /{path*}"] }],
        },
        {
          base: "https://api2.example.com",
          auth: { headers: {} },
          permissions: [{ name: "specific", rules: ["GET /data"] }],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/data", multiApi)).toEqual([
      "catchall",
      "specific",
    ]);
  });

  it("can restrict matching to one API base", () => {
    const multiApi: FirewallConfig = {
      name: "multi",
      apis: [
        {
          base: "https://api1.example.com",
          auth: { headers: {} },
          permissions: [{ name: "catchall", rules: ["GET /{path*}"] }],
        },
        {
          base: "https://api2.example.com/",
          auth: { headers: {} },
          permissions: [{ name: "specific", rules: ["GET /data"] }],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/data", multiApi, {
        apiBase: "https://api1.example.com",
      }),
    ).toEqual(["catchall"]);
    expect(
      findMatchingPermissions("GET", "/data", multiApi, {
        apiBase: "https://api2.example.com",
      }),
    ).toEqual(["specific"]);
  });

  it("returns empty array for config with no permissions", () => {
    const emptyConfig: FirewallConfig = {
      name: "empty",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/anything", emptyConfig)).toEqual(
      [],
    );
  });

  it("deduplicates permissions across multiple api entries", () => {
    const multiApi: FirewallConfig = {
      name: "multi",
      apis: [
        {
          base: "https://api1.example.com",
          auth: { headers: {} },
          permissions: [{ name: "shared-perm", rules: ["GET /data"] }],
        },
        {
          base: "https://api2.example.com",
          auth: { headers: {} },
          permissions: [{ name: "shared-perm", rules: ["GET /data"] }],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/data", multiApi)).toEqual([
      "shared-perm",
    ]);
  });
});
