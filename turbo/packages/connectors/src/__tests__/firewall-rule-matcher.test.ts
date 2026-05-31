import { describe, it, expect } from "vitest";
import {
  matchFirewallHost,
  matchFirewallPath,
  matchFirewallPathPrefix,
  matchFirewallBaseUrl,
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

  it("rejects non-terminal greedy path params", () => {
    expect(matchFirewallPath("/api/a/b/tail", "/api/{rest+}/tail")).toBeNull();
    expect(matchFirewallPath("/api/a/b/tail", "/api/{rest*}/tail")).toBeNull();
  });

  it("rejects mixed greedy path params", () => {
    expect(matchFirewallPath("/api/file-123", "/api/file-{id+}")).toBeNull();
    expect(matchFirewallPath("/api/file-123", "/api/file-{id*}")).toBeNull();
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

  it("rejects mixed host params with an empty capture", () => {
    expect(
      matchFirewallHost("api-.example.com", "api-{region}.example.com"),
    ).toBeNull();
  });

  it("matches leading greedy host params", () => {
    expect(
      matchFirewallHost("foo.bar.bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toEqual({ deployment: "foo.bar" });
  });

  it("preserves original case for leading greedy host params", () => {
    expect(
      matchFirewallHost("Foo.Bar.bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toEqual({ deployment: "Foo.Bar" });
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
    expect(
      matchFirewallHost("foo.bar.example.com", "foo.{deployment*}.com"),
    ).toBeNull();
  });

  it("rejects mixed greedy host params", () => {
    expect(
      matchFirewallHost("api-us.example.com", "api-{region+}.example.com"),
    ).toBeNull();
    expect(
      matchFirewallHost("api-us.example.com", "api-{region*}.example.com"),
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

  it("preserves repeated slashes after the base prefix", () => {
    expect(matchFirewallPathPrefix("/api/v1//users", "/api/v1")).toBe(
      "//users",
    );
  });

  it("preserves non-terminal empty base path segments", () => {
    expect(matchFirewallPathPrefix("/api/v1//users", "/api/v1/")).toBe(
      "/users",
    );
  });

  it("returns relative path after parameterized base prefix", () => {
    expect(
      matchFirewallPathPrefix("/owner/repo/main/README.md", "/{owner}/{repo}"),
    ).toBe("/main/README.md");
  });

  it("rejects empty segments for plain params in base prefixes", () => {
    expect(
      matchFirewallPathPrefix("/owner//main", "/{owner}/{repo}"),
    ).toBeNull();
  });

  it("matches mixed path segments in base prefixes", () => {
    expect(
      matchFirewallPathPrefix(
        "/owner/repo.git/info/refs",
        "/{owner}/{repo}.git",
      ),
    ).toBe("/info/refs");
  });

  it("rejects mixed path base prefixes with an empty capture", () => {
    expect(
      matchFirewallPathPrefix("/owner/.git/info/refs", "/{owner}/{repo}.git"),
    ).toBeNull();
  });

  it("keeps base boundary strict", () => {
    expect(matchFirewallPathPrefix("/apiary/users", "/api")).toBeNull();
  });

  it("rejects non-terminal greedy path params", () => {
    expect(
      matchFirewallPathPrefix("/api/a/b/tail", "/api/{rest+}/tail"),
    ).toBeNull();
    expect(
      matchFirewallPathPrefix("/api/a/b/tail", "/api/{rest*}/tail"),
    ).toBeNull();
  });

  it("rejects mixed greedy path params in base prefixes", () => {
    expect(
      matchFirewallPathPrefix("/api/file-123", "/api/file-{id+}"),
    ).toBeNull();
    expect(
      matchFirewallPathPrefix("/api/file-123", "/api/file-{id*}"),
    ).toBeNull();
  });

  it("requires plus greedy path params to consume a non-empty segment", () => {
    expect(matchFirewallPathPrefix("/api", "/api/{rest+}")).toBeNull();
    expect(matchFirewallPathPrefix("/api/", "/api/{rest+}")).toBeNull();
  });

  it("allows plus greedy path params to consume remaining segments", () => {
    expect(matchFirewallPathPrefix("/api/users/123", "/api/{rest+}")).toBe("/");
  });

  it("allows star greedy path params to consume zero segments", () => {
    expect(matchFirewallPathPrefix("/api", "/api/{rest*}")).toBe("/");
    expect(matchFirewallPathPrefix("/api/users/123", "/api/{rest*}")).toBe("/");
  });
});

describe("matchFirewallBaseUrl", () => {
  it("matches normalized static authorities and strips query fragments", () => {
    expect(
      matchFirewallBaseUrl(
        "https://API.XERO.COM.:443/api.xro/2.0/Accounts?where=Name#ignored",
        "https://api.xero.com/api.xro/2.0",
      ),
    ).toEqual({
      displayBase: "https://api.xero.com/api.xro/2.0",
      relativePath: "/Accounts",
      score: "https://api.xero.com/api.xro/2.0".length,
    });
  });

  it("matches case-insensitive schemes and normalized base authorities", () => {
    expect(
      matchFirewallBaseUrl(
        "HTTPS://API.GitHub.com/repos",
        "https://api.github.com.",
      ),
    ).toEqual({
      displayBase: "https://api.github.com.",
      relativePath: "/repos",
      score: "https://api.github.com.".length,
    });

    expect(
      matchFirewallBaseUrl(
        "https://api.github.com:8443/repos",
        "https://api.github.com.:08443",
      ),
    ).toEqual({
      displayBase: "https://api.github.com.:08443",
      relativePath: "/repos",
      score: "https://api.github.com.:08443".length,
    });
  });

  it("matches parameterized path base URLs", () => {
    expect(
      matchFirewallBaseUrl(
        "https://raw.githubusercontent.com/owner/repo/main/README.md",
        "https://raw.githubusercontent.com/{owner}/{repo}",
      ),
    ).toEqual({
      displayBase: "https://raw.githubusercontent.com/{owner}/{repo}",
      relativePath: "/main/README.md",
      score: "https://raw.githubusercontent.com/{owner}/{repo}".length,
    });
  });

  it("treats encoded slash as segment content in parameterized path bases", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/acme%2Fteam/projects/123",
        "https://api.example.com/v1/{org}",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/v1/{org}",
      relativePath: "/projects/123",
      score: "https://api.example.com/v1/{org}".length,
    });
  });

  it("matches parameterized host base URLs", () => {
    expect(
      matchFirewallBaseUrl(
        "https://ETH.G.ALCHEMY.COM/v2/demo",
        "https://{network}.g.alchemy.com",
      ),
    ).toEqual({
      displayBase: "https://{network}.g.alchemy.com",
      relativePath: "/v2/demo",
      score: "https://{network}.g.alchemy.com".length,
    });
  });

  it("returns slash when URL exactly matches the base URL", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.github.com?per_page=1#ignored",
        "https://api.github.com",
      ),
    ).toEqual({
      displayBase: "https://api.github.com",
      relativePath: "/",
      score: "https://api.github.com".length,
    });
  });

  it("treats a single trailing base slash as optional", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api/users",
        "https://api.example.com/api/",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/api",
      relativePath: "/users",
      score: "https://api.example.com/api".length,
    });
  });

  it("matches greedy parameterized host base URLs", () => {
    expect(
      matchFirewallBaseUrl(
        "https://foo.bar.bentoml.ai/api/v1/models",
        "https://{deployment+}.bentoml.ai",
      ),
    ).toEqual({
      displayBase: "https://{deployment+}.bentoml.ai",
      relativePath: "/api/v1/models",
      score: "https://{deployment+}.bentoml.ai".length,
    });
  });

  it("allows star-greedy host bases to match an empty leading host", () => {
    expect(
      matchFirewallBaseUrl(
        "https://bentoml.ai/api/v1/models",
        "https://{deployment*}.bentoml.ai",
      ),
    ).toEqual({
      displayBase: "https://{deployment*}.bentoml.ai",
      relativePath: "/api/v1/models",
      score: "https://{deployment*}.bentoml.ai".length,
    });
  });

  it("treats explicit default base ports as equivalent to omitted ports", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/users",
        "https://api.example.com:443",
      ),
    ).toEqual({
      displayBase: "https://api.example.com:443",
      relativePath: "/v1/users",
      score: "https://api.example.com:443".length,
    });

    expect(
      matchFirewallBaseUrl(
        "http://api.example.com/v1/users",
        "http://api.example.com:80",
      ),
    ).toEqual({
      displayBase: "http://api.example.com:80",
      relativePath: "/v1/users",
      score: "http://api.example.com:80".length,
    });
  });

  it("matches IPv6 base URLs with normalized default ports", () => {
    expect(
      matchFirewallBaseUrl(
        "https://[2001:db8::1]/v1/users",
        "https://[2001:db8::1]:443",
      ),
    ).toEqual({
      displayBase: "https://[2001:db8::1]:443",
      relativePath: "/v1/users",
      score: "https://[2001:db8::1]:443".length,
    });
  });

  it("matches explicit non-default base ports only on the same port", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com:8443/v1/users",
        "https://api.example.com:8443",
      ),
    ).toEqual({
      displayBase: "https://api.example.com:8443",
      relativePath: "/v1/users",
      score: "https://api.example.com:8443".length,
    });

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/users",
        "https://api.example.com:8443",
      ),
    ).toBeNull();
  });

  it("keeps static base path boundaries strict", () => {
    expect(
      matchFirewallBaseUrl(
        "https://slack.com/apix/chat.postMessage",
        "https://slack.com/api",
      ),
    ).toBeNull();
  });

  it("requires runtime URLs to use the same scheme as the base URL", () => {
    expect(
      matchFirewallBaseUrl(
        "http://api.github.com/repos/owner/repo",
        "https://api.github.com",
      ),
    ).toBeNull();
  });

  it("does not collapse repeated trailing base slashes", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api/users",
        "https://api.example.com/api//",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api//users",
        "https://api.example.com/api//",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/api/",
      relativePath: "/users",
      score: "https://api.example.com/api/".length,
    });
  });

  it("keeps base path matching case-sensitive and byte-oriented", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/API/users",
        "https://api.example.com/api",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api%2Fv1/users",
        "https://api.example.com/api/v1",
      ),
    ).toBeNull();
  });

  it("does not collapse empty segments inside parameterized base paths", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1//acme/projects",
        "https://api.example.com/v1/{org}",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/acme//projects",
        "https://api.example.com/v1/{org}",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/v1/{org}",
      relativePath: "//projects",
      score: "https://api.example.com/v1/{org}".length,
    });

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/acme/projects",
        "https://api.example.com/v1//{org}",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1//acme/projects",
        "https://api.example.com/v1//{org}",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/v1//{org}",
      relativePath: "/projects",
      score: "https://api.example.com/v1//{org}".length,
    });
  });

  it.each([
    ["raw whitespace", "https://api.github.com/foo bar"],
    ["authority backslash", "https://api.github.com\\repos/owner/repo"],
    ["userinfo", "https://user:pass@api.github.com/repos/owner/repo"],
    ["invalid authority percent escape", "https://api%zz.github.com/repos"],
    ["percent-encoded authority dot", "https://api%2egithub.com/repos"],
    ["malformed IPv6 authority", "https://[::1/repos"],
    ["non-default port", "https://api.github.com:8443/repos"],
  ])("rejects runtime URLs with %s", (_label, url) => {
    expect(matchFirewallBaseUrl(url, "https://api.github.com")).toBeNull();
  });

  it.each([
    [
      "empty host label",
      "https://.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "raw host braces",
      "https://{eth}.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "raw host comma",
      "https://eth,mainnet.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "percent-encoded host comma",
      "https://eth%2Cmainnet.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "percent-encoded host braces",
      "https://%7Beth%7D.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "percent-encoded authority colon",
      "https://api.github.com%3A443/repos",
      "https://api.github.com",
    ],
    [
      "multiple trailing host dots",
      "https://api.github.com../repos",
      "https://api.github.com",
    ],
  ])(
    "rejects runtime URLs with %s before host matching",
    (_label, url, base) => {
      expect(matchFirewallBaseUrl(url, base)).toBeNull();
    },
  );

  it("rejects malformed base URLs without string-prefix fallback", () => {
    expect(
      matchFirewallBaseUrl("https://api.github.com/repos", "https://[::1"),
    ).toBeNull();
  });

  it.each([
    ["query string", "https://api.github.com?token=1"],
    ["fragment", "https://api.github.com#fragment"],
    ["backslash", "https://api.github.com\\repos"],
    ["userinfo", "https://user:pass@api.github.com"],
    ["invalid percent escape", "https://api%zz.github.com"],
    ["percent-encoded braces", "https://%7Benv%7D.github.com"],
    ["percent-encoded dot", "https://api%2egithub.com"],
    ["percent-encoded comma", "https://api%2Cgithub.com"],
  ])("rejects base URLs with %s", (_label, base) => {
    expect(
      matchFirewallBaseUrl("https://api.github.com/repos", base),
    ).toBeNull();
  });

  it.each([
    ["whole URL template", "${{ vars.N8N_BASE_URL }}/api/v1"],
    [
      "host segment template",
      "https://${{ vars.FRESHDESK_DOMAIN }}.freshdesk.com",
    ],
  ])("does not reverse-match %s base URLs", (_label, base) => {
    expect(
      matchFirewallBaseUrl("https://example.com/api/v1/users", base),
    ).toBeNull();
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

  it("ignores rule methods that are not valid uppercase firewall methods", () => {
    const malformedMethodConfig: FirewallConfig = {
      name: "malformed-method",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "lowercase", rules: ["get /data"] },
            { name: "unknown", rules: ["BREW /data"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/data", malformedMethodConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("BREW", "/data", malformedMethodConfig),
    ).toEqual([]);
  });

  it("ignores rule paths that fail firewall validation", () => {
    const malformedPathConfig: FirewallConfig = {
      name: "malformed-path",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "missing-slash", rules: ["GET data"] },
            { name: "query", rules: ["GET /data?debug=1"] },
            { name: "fragment", rules: ["GET /data#section"] },
            { name: "backslash", rules: ["GET /data\\debug"] },
            { name: "whitespace", rules: ["GET /space path"] },
            { name: "control", rules: ["GET /data\x00debug"] },
            { name: "duplicate-param", rules: ["GET /items/{id}/{id}"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/data", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data?debug=1", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data#section", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data\\debug", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/space path", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data\x00debug", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/a/b", malformedPathConfig),
    ).toEqual([]);
  });

  it("ignores permission names that fail firewall validation", () => {
    const malformedPermissionConfig: FirewallConfig = {
      name: "malformed-permission",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "", rules: ["GET /empty"] },
            { name: "all", rules: ["GET /all"] },
            { name: "read", rules: ["GET /items/{id}"] },
            { name: "read", rules: ["DELETE /items/{id}"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/empty", malformedPermissionConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/all", malformedPermissionConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedPermissionConfig),
    ).toEqual(["read"]);
    expect(
      findMatchingPermissions("DELETE", "/items/1", malformedPermissionConfig),
    ).toEqual([]);
  });

  it("ignores empty firewall names that fail firewall validation", () => {
    const malformedNameConfig: FirewallConfig = {
      name: "",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "read", rules: ["GET /items/{id}"] }],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/items/1", malformedNameConfig),
    ).toEqual([]);
  });

  it("ignores malformed top-level firewall shapes", () => {
    const nullConfig = null as unknown as FirewallConfig;
    const arrayConfig = [] as unknown as FirewallConfig;
    const nonStringNameConfig = {
      name: 123,
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "read", rules: ["GET /items/{id}"] }],
        },
      ],
    } as unknown as FirewallConfig;
    const nonArrayApisConfig = {
      name: "malformed-apis",
      apis: { base: "https://example.com" },
    } as unknown as FirewallConfig;

    expect(findMatchingPermissions("GET", "/items/1", nullConfig)).toEqual([]);
    expect(findMatchingPermissions("GET", "/items/1", arrayConfig)).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", nonStringNameConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", nonArrayApisConfig),
    ).toEqual([]);
  });

  it("ignores API entries that fail base or auth validation", () => {
    const malformedApiConfig: FirewallConfig = {
      name: "malformed-api",
      apis: [
        {
          base: "https://example.com?token=1",
          auth: { headers: {} },
          permissions: [{ name: "query-base", rules: ["GET /items/{id}"] }],
        },
        {
          base: "ftp://example.com",
          auth: { headers: {} },
          permissions: [{ name: "bad-scheme", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://auth.example.com",
          auth: { base: "ftp://auth.example.com/token" },
          permissions: [{ name: "bad-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://valid.example.com",
          auth: { headers: {} },
          permissions: [{ name: "valid", rules: ["GET /items/{id}"] }],
        },
      ],
    };

    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig),
    ).toEqual(["valid"]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://example.com?token=1",
      }),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://auth.example.com",
      }),
    ).toEqual([]);
  });

  it("ignores API entries with malformed auth shapes", () => {
    const malformedApiConfig = {
      name: "malformed-api-shape",
      apis: [
        "not-an-api",
        {
          auth: { headers: {} },
          permissions: [{ name: "missing-base", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://missing-auth.example.com",
          permissions: [{ name: "missing-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://string-auth.example.com",
          auth: "token",
          permissions: [{ name: "string-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://bad-headers.example.com",
          auth: { headers: { Authorization: 123 } },
          permissions: [{ name: "bad-headers", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://date-headers.example.com",
          auth: { headers: new Date() },
          permissions: [{ name: "date-headers", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://bad-auth-base.example.com",
          auth: { base: 123 },
          permissions: [{ name: "bad-auth-base", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://bad-query.example.com",
          auth: { query: { api_key: 123 } },
          permissions: [{ name: "bad-query", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://date-query.example.com",
          auth: { query: new Date() },
          permissions: [{ name: "date-query", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://valid.example.com",
          auth: { headers: {} },
          permissions: [{ name: "valid", rules: ["GET /items/{id}"] }],
        },
      ],
    } as unknown as FirewallConfig;

    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig),
    ).toEqual(["valid"]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://missing-auth.example.com",
      }),
    ).toEqual([]);
  });

  it("ignores malformed permission shapes while keeping valid rules", () => {
    const malformedPermissionConfig = {
      name: "malformed-permission-shape",
      apis: [
        {
          base: "https://ignored.example.com",
          auth: { headers: {} },
          permissions: "read",
        },
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            "not-a-permission",
            { rules: ["GET /missing-name"] },
            { name: 123, rules: ["GET /non-string-name"] },
            { name: "missing-rules" },
            { name: "missing-rules", rules: ["GET /missing-rules"] },
            { name: "string-rules", rules: "GET /string-rules" },
            { name: "string-rules", rules: ["GET /string-rules"] },
            { name: "empty-rules", rules: [] },
            { name: "empty-rules", rules: ["GET /empty-rules"] },
            { name: "invalid-rule", rules: ["BREW /invalid-rule"] },
            { name: "invalid-rule", rules: ["GET /invalid-rule"] },
            { name: "non-string-rule", rules: [123] },
            { name: "non-string-rule", rules: ["GET /non-string-rule"] },
            {
              name: "valid-after-invalid-rule",
              rules: [
                "BREW /valid-after-invalid-rule",
                "GET /valid-after-invalid-rule",
              ],
            },
            {
              name: "valid-after-non-string-rule",
              rules: [123, "GET /valid-after-non-string-rule"],
            },
            { name: "mixed-rules", rules: ["GET /mixed", 123] },
            { name: "valid", rules: ["GET /items/{id}"] },
          ],
        },
      ],
    } as unknown as FirewallConfig;

    expect(
      findMatchingPermissions("GET", "/items/1", malformedPermissionConfig),
    ).toEqual(["valid"]);
    expect(
      findMatchingPermissions("GET", "/mixed", malformedPermissionConfig),
    ).toEqual(["mixed-rules"]);
    expect(
      findMatchingPermissions(
        "GET",
        "/string-rules",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/missing-rules",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/empty-rules", malformedPermissionConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/invalid-rule",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/non-string-rule",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/valid-after-invalid-rule",
        malformedPermissionConfig,
      ),
    ).toEqual(["valid-after-invalid-rule"]);
    expect(
      findMatchingPermissions(
        "GET",
        "/valid-after-non-string-rule",
        malformedPermissionConfig,
      ),
    ).toEqual(["valid-after-non-string-rule"]);
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

  it("deduplicates one permission when multiple best-specificity rules match", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            {
              name: "read",
              rules: ["GET /api/{id}", "ANY /api/{id}"],
            },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["read"],
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
