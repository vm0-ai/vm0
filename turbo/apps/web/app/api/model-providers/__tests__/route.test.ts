import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestMultiAuthModelProvider,
  deleteTestModelProvider,
  listTestModelProviders,
  listTestSecrets,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

const context = testContext();

describe("Multi-auth provider cascade deletion", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  describe("DELETE /api/model-providers/:type", () => {
    it("should delete all associated secrets when deleting multi-auth provider", async () => {
      // Create multi-auth provider with access-keys auth method
      await createTestMultiAuthModelProvider(
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );

      // Verify secrets were created
      const secretsBefore = await listTestSecrets();
      const awsSecrets = secretsBefore.filter((c) =>
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"].includes(
          c.name,
        ),
      );
      expect(awsSecrets).toHaveLength(3);

      // Delete the model provider
      await deleteTestModelProvider("aws-bedrock");

      // Verify model provider is deleted
      const providers = await listTestModelProviders();
      expect(providers.find((p) => p.type === "aws-bedrock")).toBeUndefined();

      // Verify all associated secrets are deleted
      const secretsAfter = await listTestSecrets();
      const remainingAwsSecrets = secretsAfter.filter((c) =>
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"].includes(
          c.name,
        ),
      );
      expect(remainingAwsSecrets).toHaveLength(0);
    });

    it("should delete secrets for api-key auth method when deleting provider", async () => {
      // Create multi-auth provider with api-key auth method
      await createTestMultiAuthModelProvider(
        "aws-bedrock",
        "api-key",
        {
          AWS_BEARER_TOKEN_BEDROCK: "test-bearer-token",
          AWS_REGION: "us-west-2",
        },
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );

      // Verify secrets were created
      const secretsBefore = await listTestSecrets();
      expect(
        secretsBefore.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeDefined();
      expect(secretsBefore.find((c) => c.name === "AWS_REGION")).toBeDefined();

      // Delete the model provider
      await deleteTestModelProvider("aws-bedrock");

      // Verify all associated secrets are deleted
      const secretsAfter = await listTestSecrets();
      expect(
        secretsAfter.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeUndefined();
      expect(secretsAfter.find((c) => c.name === "AWS_REGION")).toBeUndefined();
    });
  });

  // Note: With type isolation, model-provider secrets cannot be deleted via /api/secrets
  // (which only handles user-type secrets). To delete model-provider secrets, you must
  // delete the model provider itself via DELETE /api/model-providers/:type, which
  // cascades the deletion to all associated secrets.

  describe("Switching auth methods", () => {
    it("should clean up old secrets when switching auth methods", async () => {
      // Create provider with api-key auth method
      await createTestMultiAuthModelProvider(
        "aws-bedrock",
        "api-key",
        {
          AWS_BEARER_TOKEN_BEDROCK: "test-bearer-token",
          AWS_REGION: "us-west-2",
        },
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );

      // Verify api-key secrets exist
      const secretsApiKey = await listTestSecrets();
      expect(
        secretsApiKey.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeDefined();

      // Switch to access-keys auth method
      await createTestMultiAuthModelProvider(
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );

      // Verify old secrets (api-key only) are cleaned up
      const secretsAfter = await listTestSecrets();
      expect(
        secretsAfter.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeUndefined();

      // Verify new secrets exist
      expect(
        secretsAfter.find((c) => c.name === "AWS_ACCESS_KEY_ID"),
      ).toBeDefined();
      expect(
        secretsAfter.find((c) => c.name === "AWS_SECRET_ACCESS_KEY"),
      ).toBeDefined();
      expect(secretsAfter.find((c) => c.name === "AWS_REGION")).toBeDefined();

      // Verify all secrets have consistent auth method in description
      const awsSecrets = secretsAfter.filter((c) => c.name.startsWith("AWS_"));
      for (const secret of awsSecrets) {
        expect(secret.description).toContain("(access-keys)");
        expect(secret.description).not.toContain("(api-key)");
      }
    });

    it("should update secret description when auth method changes", async () => {
      // Create provider with api-key auth method (includes AWS_REGION)
      await createTestMultiAuthModelProvider(
        "aws-bedrock",
        "api-key",
        {
          AWS_BEARER_TOKEN_BEDROCK: "test-bearer-token",
          AWS_REGION: "us-west-2",
        },
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );

      // Verify AWS_REGION has api-key description
      const secretsBefore = await listTestSecrets();
      const regionBefore = secretsBefore.find((c) => c.name === "AWS_REGION");
      expect(regionBefore?.description).toContain("(api-key)");

      // Switch to access-keys (also uses AWS_REGION)
      await createTestMultiAuthModelProvider(
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );

      // Verify AWS_REGION now has access-keys description
      const secretsAfter = await listTestSecrets();
      const regionAfter = secretsAfter.find((c) => c.name === "AWS_REGION");
      expect(regionAfter?.description).toContain("(access-keys)");
    });
  });
});
