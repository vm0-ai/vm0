import { describe, it, expect } from "vitest";
import { validateBaseUrl } from "../firewall-types";
import { validateRule } from "../firewall-expander";

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
