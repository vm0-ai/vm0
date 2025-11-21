/* eslint-disable turbo/no-undeclared-env-vars */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { replaceEnvVars } from "../env-replacer";

describe("replaceEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a fresh copy of env
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  it("should replace single environment variable", () => {
    process.env.MY_TOKEN = "secret-token-123";

    const input = {
      token: "${MY_TOKEN}",
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      token: "secret-token-123",
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should replace multiple environment variables", () => {
    process.env.GITHUB_TOKEN = "ghp_123";
    process.env.AWS_KEY = "aws_456";

    const input = {
      github: {
        token: "${GITHUB_TOKEN}",
      },
      aws: {
        key: "${AWS_KEY}",
      },
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      github: {
        token: "ghp_123",
      },
      aws: {
        key: "aws_456",
      },
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should replace environment variables in arrays", () => {
    process.env.TOKEN_1 = "token1";
    process.env.TOKEN_2 = "token2";

    const input = {
      tokens: ["${TOKEN_1}", "${TOKEN_2}", "static-value"],
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      tokens: ["token1", "token2", "static-value"],
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should replace environment variables in nested objects", () => {
    process.env.NESTED_TOKEN = "nested-123";

    const input = {
      level1: {
        level2: {
          level3: {
            token: "${NESTED_TOKEN}",
          },
        },
      },
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      level1: {
        level2: {
          level3: {
            token: "nested-123",
          },
        },
      },
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should handle missing environment variables", () => {
    const input = {
      token: "${MISSING_VAR}",
    };

    const result = replaceEnvVars(input);

    // Should keep placeholder unchanged
    expect(result.config).toEqual({
      token: "${MISSING_VAR}",
    });
    // Should report error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("MISSING_VAR");
  });

  it("should handle multiple missing variables", () => {
    const input = {
      token1: "${MISSING_1}",
      token2: "${MISSING_2}",
    };

    const result = replaceEnvVars(input);

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("MISSING_1");
    expect(result.errors[1]).toContain("MISSING_2");
  });

  it("should not replace non-matching patterns", () => {
    process.env.VALID_VAR = "valid";

    const input = {
      valid: "${VALID_VAR}",
      invalid1: "$INVALID_VAR", // Missing braces
      invalid2: "{INVALID_VAR}", // Missing dollar
      invalid3: "$(INVALID_VAR)", // Wrong brackets
      invalid4: "${invalid-var}", // Lowercase/hyphen not allowed
      static: "static-value",
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      valid: "valid",
      invalid1: "$INVALID_VAR",
      invalid2: "{INVALID_VAR}",
      invalid3: "$(INVALID_VAR)",
      invalid4: "${invalid-var}",
      static: "static-value",
    });
    // Only valid var replaced, no errors for non-matching patterns
    expect(result.errors).toHaveLength(0);
  });

  it("should handle strings with multiple variables", () => {
    process.env.USER = "john";
    process.env.DOMAIN = "example.com";

    const input = {
      email: "${USER}@${DOMAIN}",
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      email: "john@example.com",
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should handle real-world git volume config", () => {
    process.env.CI_GITHUB_TOKEN = "ghp_test_token_123";

    const input = {
      version: "1.0",
      agent: {
        name: "test-agent",
        volumes: ["my-repo:/home/user/repo"],
      },
      volumes: {
        "my-repo": {
          driver: "git",
          driver_opts: {
            repo: "owner/repo",
            branch: "main",
            token: "${CI_GITHUB_TOKEN}",
          },
        },
      },
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      version: "1.0",
      agent: {
        name: "test-agent",
        volumes: ["my-repo:/home/user/repo"],
      },
      volumes: {
        "my-repo": {
          driver: "git",
          driver_opts: {
            repo: "owner/repo",
            branch: "main",
            token: "ghp_test_token_123",
          },
        },
      },
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should preserve other types unchanged", () => {
    process.env.MY_VAR = "replaced";

    const input = {
      string: "${MY_VAR}",
      number: 42,
      boolean: true,
      null_value: null,
      undefined_value: undefined,
    };

    const result = replaceEnvVars(input);

    expect(result.config).toEqual({
      string: "replaced",
      number: 42,
      boolean: true,
      null_value: null,
      undefined_value: undefined,
    });
    expect(result.errors).toHaveLength(0);
  });
});
