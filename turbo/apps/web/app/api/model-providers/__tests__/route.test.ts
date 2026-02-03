import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestMultiAuthModelProvider,
  deleteTestModelProvider,
  listTestModelProviders,
  listTestCredentials,
  deleteTestCredential,
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
    it("should delete all associated credentials when deleting multi-auth provider", async () => {
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

      // Verify credentials were created
      const credentialsBefore = await listTestCredentials();
      const awsCredentials = credentialsBefore.filter((c) =>
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"].includes(
          c.name,
        ),
      );
      expect(awsCredentials).toHaveLength(3);

      // Delete the model provider
      await deleteTestModelProvider("aws-bedrock");

      // Verify model provider is deleted
      const providers = await listTestModelProviders();
      expect(providers.find((p) => p.type === "aws-bedrock")).toBeUndefined();

      // Verify all associated credentials are deleted
      const credentialsAfter = await listTestCredentials();
      const remainingAwsCredentials = credentialsAfter.filter((c) =>
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"].includes(
          c.name,
        ),
      );
      expect(remainingAwsCredentials).toHaveLength(0);
    });

    it("should delete credentials for api-key auth method when deleting provider", async () => {
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

      // Verify credentials were created
      const credentialsBefore = await listTestCredentials();
      expect(
        credentialsBefore.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeDefined();
      expect(
        credentialsBefore.find((c) => c.name === "AWS_REGION"),
      ).toBeDefined();

      // Delete the model provider
      await deleteTestModelProvider("aws-bedrock");

      // Verify all associated credentials are deleted
      const credentialsAfter = await listTestCredentials();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeUndefined();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_REGION"),
      ).toBeUndefined();
    });
  });

  describe("DELETE /api/credentials/:name", () => {
    it("should delete model provider when deleting a required credential", async () => {
      // Create multi-auth provider
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

      // Verify provider exists
      const providersBefore = await listTestModelProviders();
      expect(
        providersBefore.find((p) => p.type === "aws-bedrock"),
      ).toBeDefined();

      // Delete a required credential (AWS_ACCESS_KEY_ID is required for access-keys)
      await deleteTestCredential("AWS_ACCESS_KEY_ID");

      // Verify model provider is also deleted
      const providersAfter = await listTestModelProviders();
      expect(
        providersAfter.find((p) => p.type === "aws-bedrock"),
      ).toBeUndefined();

      // Verify other credentials are also deleted
      const credentialsAfter = await listTestCredentials();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_SECRET_ACCESS_KEY"),
      ).toBeUndefined();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_REGION"),
      ).toBeUndefined();
    });
  });

  describe("Switching auth methods", () => {
    it("should clean up old credentials when switching auth methods", async () => {
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

      // Verify api-key credentials exist
      const credentialsApiKey = await listTestCredentials();
      expect(
        credentialsApiKey.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
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

      // Verify old credentials (api-key only) are cleaned up
      const credentialsAfter = await listTestCredentials();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_BEARER_TOKEN_BEDROCK"),
      ).toBeUndefined();

      // Verify new credentials exist
      expect(
        credentialsAfter.find((c) => c.name === "AWS_ACCESS_KEY_ID"),
      ).toBeDefined();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_SECRET_ACCESS_KEY"),
      ).toBeDefined();
      expect(
        credentialsAfter.find((c) => c.name === "AWS_REGION"),
      ).toBeDefined();

      // Verify all credentials have consistent auth method in description
      const awsCredentials = credentialsAfter.filter((c) =>
        c.name.startsWith("AWS_"),
      );
      for (const cred of awsCredentials) {
        expect(cred.description).toContain("(access-keys)");
        expect(cred.description).not.toContain("(api-key)");
      }
    });

    it("should update credential description when auth method changes", async () => {
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
      const credentialsBefore = await listTestCredentials();
      const regionBefore = credentialsBefore.find(
        (c) => c.name === "AWS_REGION",
      );
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
      const credentialsAfter = await listTestCredentials();
      const regionAfter = credentialsAfter.find((c) => c.name === "AWS_REGION");
      expect(regionAfter?.description).toContain("(access-keys)");
    });
  });
});
