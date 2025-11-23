import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  expandEnvVars,
  expandEnvVarsInObject,
  extractEnvVarReferences,
  validateEnvVars,
} from "../env-expander";

describe("env-expander", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a clean copy of env
    process.env = { ...originalEnv };
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.TEST_TOKEN = "secret-token-123";
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.TEST_USER = "testuser";
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.TEST_REGION = "us-east-1";
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe("expandEnvVars", () => {
    it("should expand single environment variable", () => {
      const result = expandEnvVars("token: ${TEST_TOKEN}");
      expect(result).toBe("token: secret-token-123");
    });

    it("should expand multiple environment variables", () => {
      const result = expandEnvVars(
        "https://github.com/${TEST_USER}/repo?token=${TEST_TOKEN}",
      );
      expect(result).toBe(
        "https://github.com/testuser/repo?token=secret-token-123",
      );
    });

    it("should return empty string for undefined environment variable", () => {
      const result = expandEnvVars("${UNDEFINED_VAR}");
      expect(result).toBe("");
    });

    it("should handle mixed content with env vars", () => {
      const result = expandEnvVars("prefix-${TEST_USER}-suffix");
      expect(result).toBe("prefix-testuser-suffix");
    });

    it("should not modify strings without env vars", () => {
      const result = expandEnvVars("no variables here");
      expect(result).toBe("no variables here");
    });

    it("should handle empty string", () => {
      const result = expandEnvVars("");
      expect(result).toBe("");
    });
  });

  describe("expandEnvVarsInObject", () => {
    it("should expand env vars in string values", () => {
      const obj = {
        token: "${TEST_TOKEN}",
        user: "${TEST_USER}",
      };
      const result = expandEnvVarsInObject(obj);
      expect(result).toEqual({
        token: "secret-token-123",
        user: "testuser",
      });
    });

    it("should expand env vars in nested objects", () => {
      const obj = {
        config: {
          auth: {
            token: "${TEST_TOKEN}",
          },
          user: "${TEST_USER}",
        },
      };
      const result = expandEnvVarsInObject(obj);
      expect(result).toEqual({
        config: {
          auth: {
            token: "secret-token-123",
          },
          user: "testuser",
        },
      });
    });

    it("should expand env vars in arrays", () => {
      const obj = {
        tokens: ["${TEST_TOKEN}", "${TEST_USER}"],
      };
      const result = expandEnvVarsInObject(obj);
      expect(result).toEqual({
        tokens: ["secret-token-123", "testuser"],
      });
    });

    it("should preserve non-string values", () => {
      const obj = {
        count: 42,
        enabled: true,
        data: null,
        list: [1, 2, 3],
      };
      const result = expandEnvVarsInObject(obj);
      expect(result).toEqual(obj);
    });

    it("should handle complex nested structures", () => {
      const obj = {
        agent: {
          name: "test-agent",
          volumes: ["system:/home", "workspace:/work"],
        },
        dynamic_volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/${TEST_USER}/repo",
              token: "${TEST_TOKEN}",
              branch: "main",
            },
          },
        },
        volumes: {
          system: {
            driver: "s3fs",
            driver_opts: {
              uri: "s3://bucket/${TEST_USER}/data",
              region: "${TEST_REGION}",
            },
          },
        },
      };

      const result = expandEnvVarsInObject(obj);
      expect(result).toEqual({
        agent: {
          name: "test-agent",
          volumes: ["system:/home", "workspace:/work"],
        },
        dynamic_volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/testuser/repo",
              token: "secret-token-123",
              branch: "main",
            },
          },
        },
        volumes: {
          system: {
            driver: "s3fs",
            driver_opts: {
              uri: "s3://bucket/testuser/data",
              region: "us-east-1",
            },
          },
        },
      });
    });

    it("should handle primitives", () => {
      expect(expandEnvVarsInObject("${TEST_TOKEN}")).toBe("secret-token-123");
      expect(expandEnvVarsInObject(42)).toBe(42);
      expect(expandEnvVarsInObject(true)).toBe(true);
      expect(expandEnvVarsInObject(null)).toBe(null);
      expect(expandEnvVarsInObject(undefined)).toBe(undefined);
    });
  });

  describe("extractEnvVarReferences", () => {
    it("should extract single variable from string", () => {
      const result = extractEnvVarReferences("token: ${TEST_TOKEN}");
      expect(result).toEqual(["TEST_TOKEN"]);
    });

    it("should extract multiple variables from string", () => {
      const result = extractEnvVarReferences(
        "https://github.com/${TEST_USER}/repo?token=${TEST_TOKEN}",
      );
      expect(result).toEqual(["TEST_USER", "TEST_TOKEN"]);
    });

    it("should extract variables from object", () => {
      const obj = {
        token: "${TEST_TOKEN}",
        user: "${TEST_USER}",
      };
      const result = extractEnvVarReferences(obj);
      expect(result).toEqual(["TEST_TOKEN", "TEST_USER"]);
    });

    it("should extract variables from nested objects", () => {
      const obj = {
        config: {
          auth: {
            token: "${TEST_TOKEN}",
          },
          user: "${TEST_USER}",
        },
        region: "${TEST_REGION}",
      };
      const result = extractEnvVarReferences(obj);
      expect(result).toEqual(["TEST_TOKEN", "TEST_USER", "TEST_REGION"]);
    });

    it("should extract variables from arrays", () => {
      const obj = {
        tokens: ["${TEST_TOKEN}", "${TEST_USER}"],
      };
      const result = extractEnvVarReferences(obj);
      expect(result).toEqual(["TEST_TOKEN", "TEST_USER"]);
    });

    it("should return unique variable names", () => {
      const obj = {
        token1: "${TEST_TOKEN}",
        token2: "${TEST_TOKEN}",
        user: "${TEST_USER}",
      };
      const result = extractEnvVarReferences(obj);
      expect(result).toEqual(["TEST_TOKEN", "TEST_USER"]);
    });

    it("should handle multiple variables in single string", () => {
      const result = extractEnvVarReferences(
        "${TEST_USER}:${TEST_TOKEN}:${TEST_REGION}",
      );
      expect(result).toEqual(["TEST_USER", "TEST_TOKEN", "TEST_REGION"]);
    });

    it("should return empty array for no variables", () => {
      const obj = {
        name: "test-agent",
        count: 42,
        enabled: true,
      };
      const result = extractEnvVarReferences(obj);
      expect(result).toEqual([]);
    });

    it("should handle empty string", () => {
      const result = extractEnvVarReferences("");
      expect(result).toEqual([]);
    });

    it("should handle null and undefined", () => {
      expect(extractEnvVarReferences(null)).toEqual([]);
      expect(extractEnvVarReferences(undefined)).toEqual([]);
    });

    it("should handle complex nested structures", () => {
      const obj = {
        agent: {
          name: "test-agent",
        },
        dynamic_volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/${TEST_USER}/repo",
              token: "${TEST_TOKEN}",
            },
          },
        },
        volumes: {
          system: {
            driver: "s3fs",
            driver_opts: {
              uri: "s3://bucket/${TEST_USER}/data",
              region: "${TEST_REGION}",
            },
          },
        },
      };

      const result = extractEnvVarReferences(obj);
      expect(result).toEqual(["TEST_USER", "TEST_TOKEN", "TEST_REGION"]);
    });
  });

  describe("validateEnvVars", () => {
    it("should return empty array when all variables are defined", () => {
      const result = validateEnvVars(["TEST_TOKEN", "TEST_USER"]);
      expect(result).toEqual([]);
    });

    it("should return missing variables", () => {
      const result = validateEnvVars([
        "TEST_TOKEN",
        "MISSING_VAR",
        "ANOTHER_MISSING",
      ]);
      expect(result).toEqual(["MISSING_VAR", "ANOTHER_MISSING"]);
    });

    it("should return all variables when none are defined", () => {
      const result = validateEnvVars(["UNDEFINED_1", "UNDEFINED_2"]);
      expect(result).toEqual(["UNDEFINED_1", "UNDEFINED_2"]);
    });

    it("should handle empty array", () => {
      const result = validateEnvVars([]);
      expect(result).toEqual([]);
    });

    it("should detect undefined vs empty string", () => {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      process.env.EMPTY_VAR = "";
      const result = validateEnvVars(["EMPTY_VAR", "UNDEFINED_VAR"]);
      expect(result).toEqual(["UNDEFINED_VAR"]);
    });
  });
});
