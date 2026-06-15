import { describe, it, expect } from "vitest";
import { validateBaseUrl } from "../firewall-types";
import { validateRule } from "../firewall-expander";
import { matchFirewallPath } from "../firewall-rule-matcher";

describe("mixed {param}{literal} segments — validateBaseUrl", () => {
  it("accepts parameter + literal suffix in path", () => {
    expect(() => {
      return validateBaseUrl("https://github.com/{owner}/{repo}.git", "github");
    }).not.toThrow();
  });

  it("accepts literal prefix + parameter in path", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/v{version}/x", "example");
    }).not.toThrow();
  });

  it("accepts literal prefix + parameter + suffix in path", () => {
    expect(() => {
      return validateBaseUrl("https://example.com/pre-{id}.json", "example");
    }).not.toThrow();
  });

  it("accepts mixed segments in host", () => {
    expect(() => {
      return validateBaseUrl("https://api-{region}.example.com", "example");
    }).not.toThrow();
  });

  it("rejects adjacent parameters", () => {
    expect(() => {
      return validateBaseUrl("https://example.com/{a}{b}", "example");
    }).toThrow(/adjacent parameters/);
  });

  it("rejects literal-separated parameters", () => {
    expect(() => {
      return validateBaseUrl("https://example.com/{a}.{b}", "example");
    }).toThrow(/literal-separated parameters/);
  });

  it("rejects empty parameter name in mixed segment", () => {
    expect(() => {
      return validateBaseUrl("https://example.com/prefix{}suffix", "example");
    }).toThrow(/empty parameter name/);
  });

  it("rejects unbalanced brace", () => {
    // Tested via validateRule since hasBaseUrlParams requires both "{" and
    // "}" to route validateBaseUrl through the parameterized path.
    expect(() => {
      return validateRule("GET /foo/{name}extra{", "read", "svc");
    }).toThrow(/unbalanced brace/);
  });

  it("rejects greedy combined with literal prefix/suffix in host", () => {
    expect(() => {
      return validateBaseUrl("https://api-{sub+}.example.com", "example");
    }).toThrow(/cannot be combined with a literal/);
  });

  it("rejects greedy in base URL path even without prefix/suffix", () => {
    expect(() => {
      return validateBaseUrl("https://example.com/{rest+}", "example");
    }).toThrow(/greedy parameter/);
  });

  it("existing whole-segment patterns still validate", () => {
    expect(() => {
      return validateBaseUrl("https://api.github.com/{owner}/{repo}", "github");
    }).not.toThrow();
  });
});

describe("mixed {param}{literal} segments — validateRule", () => {
  it("accepts parameter + literal suffix", () => {
    expect(() => {
      return validateRule("GET /api/{id}.json", "read", "svc");
    }).not.toThrow();
  });

  it("accepts literal prefix + parameter", () => {
    expect(() => {
      return validateRule("POST /v{version}/x", "write", "svc");
    }).not.toThrow();
  });

  it("rejects adjacent parameters in rule path", () => {
    expect(() => {
      return validateRule("GET /foo/{a}{b}", "read", "svc");
    }).toThrow(/adjacent parameters/);
  });

  it("rejects empty parameter name in rule path", () => {
    expect(() => {
      return validateRule("GET /foo/pre{}suf", "read", "svc");
    }).toThrow(/empty parameter name/);
  });

  it("rejects greedy with literal suffix", () => {
    expect(() => {
      return validateRule("GET /foo/{rest+}.json", "read", "svc");
    }).toThrow(/cannot be combined with a literal/);
  });

  it("rejects non-dot literal-separated parameters ({a}abc{b})", () => {
    expect(() => {
      return validateRule("GET /foo/{a}abc{b}", "read", "svc");
    }).toThrow(/literal-separated parameters/);
  });

  it("rejects closing brace with no opener (name})", () => {
    expect(() => {
      return validateRule("GET /foo/name}", "read", "svc");
    }).toThrow(/unbalanced brace/);
  });

  it("rejects three adjacent parameters ({a}{b}{c})", () => {
    expect(() => {
      return validateRule("GET /foo/{a}{b}{c}", "read", "svc");
    }).toThrow(/adjacent parameters/);
  });
});

describe("mixed {param}{literal} segments — matchFirewallPath", () => {
  it("extracts middle from {id}.json", () => {
    expect(matchFirewallPath("/api/42.json", "/api/{id}.json")).toEqual({
      id: "42",
    });
  });

  it("returns null when middle would be empty ({repo}.git vs .git)", () => {
    expect(
      matchFirewallPath("/repos/octocat/.git", "/repos/{owner}/{repo}.git"),
    ).toBeNull();
  });

  it("extracts owner and repo from {owner}/{repo}.git", () => {
    expect(
      matchFirewallPath(
        "/repos/octocat/hello.git",
        "/repos/{owner}/{repo}.git",
      ),
    ).toEqual({ owner: "octocat", repo: "hello" });
  });

  it("extracts version from v{version}", () => {
    expect(matchFirewallPath("/v1/x", "/v{version}/x")).toEqual({
      version: "1",
    });
  });

  it("extracts middle when prefix and suffix are both present", () => {
    expect(matchFirewallPath("/pre-abc.ext", "/pre-{name}.ext")).toEqual({
      name: "abc",
    });
  });

  it("returns null when prefix does not match", () => {
    expect(matchFirewallPath("/foo-abc.ext", "/pre-{name}.ext")).toBeNull();
  });

  it("returns null when suffix does not match", () => {
    expect(matchFirewallPath("/pre-abc.txt", "/pre-{name}.ext")).toBeNull();
  });

  it("captures middle containing a dot (repo name with a literal dot)", () => {
    // Runtime segment "foo.bar.git" matches pattern segment "{repo}.git":
    // prefix="", suffix=".git", middle captures the first "foo.bar" part.
    expect(
      matchFirewallPath(
        "/repos/octocat/foo.bar.git",
        "/repos/{owner}/{repo}.git",
      ),
    ).toEqual({ owner: "octocat", repo: "foo.bar" });
  });

  it("mixed segment path matching is case-sensitive", () => {
    // Paths are case-sensitive; uppercase prefix in runtime must not match
    // lowercase prefix in pattern.
    expect(matchFirewallPath("/PRE-abc.ext", "/pre-{name}.ext")).toBeNull();
  });

  it("returns null when prefix is longer than runtime segment", () => {
    // Defensive: prefix length exceeds segment length. startsWith returns
    // false, guard never reaches slice with negative bounds.
    expect(matchFirewallPath("/ab", "/prefix-{name}.ext")).toBeNull();
  });
});

describe("mixed {param}{literal} segments — host + path combined", () => {
  it("accepts mixed host with mixed path", () => {
    expect(() => {
      return validateBaseUrl(
        "https://api-{region}.example.com/v{version}/x",
        "combo",
      );
    }).not.toThrow();
  });

  it("rejects duplicate param names across host and mixed path", () => {
    expect(() => {
      return validateBaseUrl("https://api-{id}.example.com/v{id}", "combo");
    }).toThrow(/duplicate parameter name/);
  });
});
