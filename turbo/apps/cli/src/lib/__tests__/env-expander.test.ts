import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { expandEnvVars, expandEnvVarsInObject } from "../env-expander";

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
});
