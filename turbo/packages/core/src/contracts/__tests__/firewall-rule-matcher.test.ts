import { describe, it, expect } from "vitest";
import {
  matchFirewallPath,
  findMatchingPermissions,
  type GraphQLBody,
} from "../firewall-rule-matcher";
import type { FirewallConfig } from "../firewalls";

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

  it("handles paths with trailing slashes", () => {
    expect(matchFirewallPath("/api/v1/users/", "/api/v1/users")).toEqual({});
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

  it("returns multiple permissions when rules overlap", () => {
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
      ["specific", "catchall"],
    );
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

describe("findMatchingPermissions with GraphQL rules", () => {
  const gqlConfig: FirewallConfig = {
    name: "linear",
    apis: [
      {
        base: "https://api.linear.app",
        auth: { headers: {} },
        permissions: [
          {
            name: "read",
            rules: ["POST /graphql GraphQL type:query"],
          },
          {
            name: "write",
            rules: ["POST /graphql GraphQL type:mutation"],
          },
          {
            name: "issues-create",
            rules: [
              "POST /graphql GraphQL type:mutation operationName:issueCreate",
            ],
          },
          {
            name: "wildcard",
            rules: ["POST /graphql GraphQL operationName:issue*"],
          },
        ],
      },
    ],
  };

  const queryBody: GraphQLBody = { type: "query", operationName: "GetViewer" };
  const mutationBody: GraphQLBody = {
    type: "mutation",
    operationName: "issueCreate",
  };

  it("type:query matches query body", () => {
    expect(
      findMatchingPermissions("POST", "/graphql", gqlConfig, queryBody),
    ).toContain("read");
  });

  it("type:query does not match mutation body", () => {
    expect(
      findMatchingPermissions("POST", "/graphql", gqlConfig, mutationBody),
    ).not.toContain("read");
  });

  it("type:mutation matches mutation body", () => {
    expect(
      findMatchingPermissions("POST", "/graphql", gqlConfig, mutationBody),
    ).toContain("write");
  });

  it("type:mutation + operationName matches exact name", () => {
    expect(
      findMatchingPermissions("POST", "/graphql", gqlConfig, mutationBody),
    ).toContain("issues-create");
  });

  it("operationName wildcard matches prefix", () => {
    const body: GraphQLBody = {
      type: "mutation",
      operationName: "issueUpdate",
    };
    expect(
      findMatchingPermissions("POST", "/graphql", gqlConfig, body),
    ).toContain("wildcard");
  });

  it("operationName wildcard does not match different prefix", () => {
    const body: GraphQLBody = {
      type: "mutation",
      operationName: "commentCreate",
    };
    const perms = findMatchingPermissions("POST", "/graphql", gqlConfig, body);
    expect(perms).not.toContain("wildcard");
    expect(perms).not.toContain("issues-create");
  });

  it("returns empty when no body provided for graphql rules", () => {
    expect(findMatchingPermissions("POST", "/graphql", gqlConfig)).toEqual([]);
  });

  it("returns empty when body has no operationName and rule requires it", () => {
    const noOpBody: GraphQLBody = { type: "mutation" };
    const perms = findMatchingPermissions(
      "POST",
      "/graphql",
      gqlConfig,
      noOpBody,
    );
    expect(perms).not.toContain("issues-create");
    expect(perms).not.toContain("wildcard");
  });

  it("path must match before body check", () => {
    expect(
      findMatchingPermissions("POST", "/v2", gqlConfig, queryBody),
    ).toEqual([]);
  });

  it("type:subscription matches subscription body", () => {
    const subConfig: FirewallConfig = {
      name: "sub-test",
      apis: [
        {
          base: "https://api.example.com",
          auth: { headers: {} },
          permissions: [
            {
              name: "subscribe",
              rules: ["POST /graphql GraphQL type:subscription"],
            },
          ],
        },
      ],
    };
    const subBody: GraphQLBody = {
      type: "subscription",
      operationName: "OnUpdate",
    };
    expect(
      findMatchingPermissions("POST", "/graphql", subConfig, subBody),
    ).toEqual(["subscribe"]);
  });

  it("non-graphql rules still work when body is provided", () => {
    const mixedConfig: FirewallConfig = {
      name: "mixed",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "rest-perm", rules: ["GET /api/users"] },
            {
              name: "gql-perm",
              rules: ["POST /graphql GraphQL type:query"],
            },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/api/users", mixedConfig, queryBody),
    ).toEqual(["rest-perm"]);
  });
});
