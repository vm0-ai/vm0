/**
 * Unit tests for environment expansion
 *
 * These tests validate the runtime environment expansion behavior including:
 * - Missing required secrets validation
 * - Missing required vars validation
 * - Successful expansion when all values provided
 *
 * Replaces E2E tests from t22-vm0-experimental-shorthand.bats:
 * - "vm0 run fails when experimental_secrets shorthand secrets are missing"
 * - "vm0 run fails when experimental_vars shorthand vars are missing"
 */

import { describe, it, expect } from "vitest";
import { expandEnvironmentFromCompose } from "../expand-environment";
import { BadRequestError } from "../../../errors";

describe("expandEnvironmentFromCompose", () => {
  const userId = "user-123";
  const runId = "run-456";

  describe("missing required secrets", () => {
    it("should throw BadRequestError when required secrets are not provided", () => {
      // Compose config transformed from experimental_secrets: ["API_KEY", "DB_URL"]
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
              DB_URL: "${{ secrets.DB_URL }}",
            },
          },
        },
      };

      // No secrets provided
      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined, // vars
          undefined, // secrets (missing!)
          undefined, // credentials
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestError);
        expect((error as BadRequestError).message).toContain(
          "Missing required secrets",
        );
        expect((error as BadRequestError).message).toContain("API_KEY");
      }
    });

    it("should throw BadRequestError when only some secrets are provided", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
              DB_URL: "${{ secrets.DB_URL }}",
            },
          },
        },
      };

      // Only API_KEY provided, DB_URL missing
      const secrets = { API_KEY: "test-api-key" };

      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined,
          secrets,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          secrets,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect((error as BadRequestError).message).toContain(
          "Missing required secrets",
        );
        expect((error as BadRequestError).message).toContain("DB_URL");
        expect((error as BadRequestError).message).not.toContain("API_KEY");
      }
    });

    it("should include usage hint in error message", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
            },
          },
        },
      };

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect((error as BadRequestError).message).toContain("--secrets");
        expect((error as BadRequestError).message).toContain("API_KEY=<value>");
      }
    });

    it("should include --env-file hint in error message", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
            },
          },
        },
      };

      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect((error as BadRequestError).message).toContain("--env-file");
      }
    });
  });

  describe("missing required vars", () => {
    it("should throw BadRequestError when required vars are not provided", () => {
      // Compose config transformed from experimental_vars: ["CLOUD_NAME", "REGION"]
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              CLOUD_NAME: "${{ vars.CLOUD_NAME }}",
              REGION: "${{ vars.REGION }}",
            },
          },
        },
      };

      // No vars provided
      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined, // vars (missing!)
          undefined,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestError);
        expect((error as BadRequestError).message).toContain(
          "Missing required variables",
        );
        expect((error as BadRequestError).message).toContain("CLOUD_NAME");
      }
    });

    it("should throw BadRequestError when only some vars are provided", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              CLOUD_NAME: "${{ vars.CLOUD_NAME }}",
              REGION: "${{ vars.REGION }}",
            },
          },
        },
      };

      // Only CLOUD_NAME provided
      const vars = { CLOUD_NAME: "mycloud" };

      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          vars,
          undefined,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          vars,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect((error as BadRequestError).message).toContain(
          "Missing required variables",
        );
        expect((error as BadRequestError).message).toContain("REGION");
        expect((error as BadRequestError).message).not.toContain("CLOUD_NAME");
      }
    });

    it("should include --vars and --env-file hints in error message", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              CLOUD_NAME: "${{ vars.CLOUD_NAME }}",
            },
          },
        },
      };

      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        expect((error as BadRequestError).message).toContain("--vars");
        expect((error as BadRequestError).message).toContain(
          "CLOUD_NAME=<value>",
        );
        expect((error as BadRequestError).message).toContain("--env-file");
      }
    });
  });

  describe("combined secrets and vars", () => {
    it("should validate both secrets and vars", () => {
      // Config with both secrets and vars (from experimental_secrets and experimental_vars)
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
              DB_URL: "${{ secrets.DB_URL }}",
              CLOUD_NAME: "${{ vars.CLOUD_NAME }}",
              REGION: "${{ vars.REGION }}",
            },
          },
        },
      };

      // Secrets provided but not vars - should fail on secrets first
      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          undefined,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        // Should fail on missing secrets first (checked before vars)
        expect((error as BadRequestError).message).toContain(
          "Missing required secrets",
        );
      }

      // Now provide secrets but not vars
      const secrets = { API_KEY: "key", DB_URL: "url" };

      expect(() =>
        expandEnvironmentFromCompose(
          compose,
          undefined, // vars still missing
          secrets,
          undefined,
          userId,
          runId,
        ),
      ).toThrow(BadRequestError);

      try {
        expandEnvironmentFromCompose(
          compose,
          undefined,
          secrets,
          undefined,
          userId,
          runId,
        );
      } catch (error) {
        // Should now fail on missing vars
        expect((error as BadRequestError).message).toContain(
          "Missing required variables",
        );
      }
    });
  });

  describe("successful expansion", () => {
    it("should expand secrets and vars when all values provided", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
              CLOUD_NAME: "${{ vars.CLOUD_NAME }}",
            },
          },
        },
      };

      const vars = { CLOUD_NAME: "mycloud" };
      const secrets = { API_KEY: "secret-key" };

      const result = expandEnvironmentFromCompose(
        compose,
        vars,
        secrets,
        undefined,
        userId,
        runId,
      );

      expect(result.environment).toBeDefined();
      expect(result.environment!["CLOUD_NAME"]).toBe("mycloud");
      expect(result.environment!["API_KEY"]).toBe("secret-key");
    });

    it("should return undefined environment when compose has no agents", () => {
      const compose = { version: "1.0" };

      const result = expandEnvironmentFromCompose(
        compose,
        undefined,
        undefined,
        undefined,
        userId,
        runId,
      );

      expect(result.environment).toBeUndefined();
    });

    it("should return undefined environment when agent has no environment", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
          },
        },
      };

      const result = expandEnvironmentFromCompose(
        compose,
        undefined,
        undefined,
        undefined,
        userId,
        runId,
      );

      expect(result.environment).toBeUndefined();
    });
  });

  describe("seal_secrets mode", () => {
    it("should encrypt secrets when seal_secrets is enabled", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            experimental_firewall: {
              experimental_seal_secrets: true,
            },
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
            },
          },
        },
      };

      const secrets = { API_KEY: "my-secret-key" };

      const result = expandEnvironmentFromCompose(
        compose,
        undefined,
        secrets,
        undefined,
        userId,
        runId,
      );

      expect(result.sealSecretsEnabled).toBe(true);
      // Secret should be encrypted (mocked to prefix with vm0_enc_)
      expect(result.environment!["API_KEY"]).toContain("vm0_enc_");
    });

    it("should pass secrets in plaintext when seal_secrets is disabled", () => {
      const compose = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            environment: {
              API_KEY: "${{ secrets.API_KEY }}",
            },
          },
        },
      };

      const secrets = { API_KEY: "my-secret-key" };

      const result = expandEnvironmentFromCompose(
        compose,
        undefined,
        secrets,
        undefined,
        userId,
        runId,
      );

      expect(result.sealSecretsEnabled).toBe(false);
      expect(result.environment!["API_KEY"]).toBe("my-secret-key");
    });
  });
});
