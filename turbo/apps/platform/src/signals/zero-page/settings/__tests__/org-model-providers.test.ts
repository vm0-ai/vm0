import { describe, expect, it } from "vitest";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import {
  orgOpenAddDialog$,
  orgSubmitDialog$,
  orgDialogFormValues$,
  orgFormErrors$,
  orgUpdateFormAuthMethod$,
  orgUpdateFormModel$,
  orgUpdateFormSecret$,
  orgUpdateFormSecretField$,
} from "../org-model-providers.ts";
import { getProviderShape } from "../../../../views/zero-page/components/settings/provider-ui-config.ts";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { createMockApi } from "../../../../mocks/msw-contract.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("org-model-providers vm0 provider", () => {
  it("should treat vm0 as a no-secret provider shape, not api-key", () => {
    const shape = getProviderShape("vm0");
    expect(shape).not.toBe("api-key");
    expect(shape).toBe("no-secret");
  });

  it("should not require an API key when submitting a vm0 provider", async () => {
    const { store, signal } = context;
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(201, {
          provider: {
            id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
            type: "vm0",
            framework: "claude-code",
            secretName: null,
            authMethod: null,
            secretNames: null,
            isDefault: true,
            selectedModel: (capturedBody.selectedModel as string) ?? null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    // Open the add dialog for vm0
    store.set(orgOpenAddDialog$, "vm0");

    // Submit without providing any secret (vm0 should not need one)
    await store.set(orgSubmitDialog$, signal);

    // Should not have validation errors
    const errors = store.get(orgFormErrors$);
    expect(errors).toStrictEqual({});

    // Should have sent the request
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.type).toBe("vm0");
  });

  it("should include selectedModel when user accepts the pre-selected default without changing it", async () => {
    const { store, signal } = context;
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(201, {
          provider: {
            id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
            type: "vm0",
            framework: "claude-code",
            secretName: null,
            authMethod: null,
            secretNames: null,
            isDefault: true,
            selectedModel: (capturedBody.selectedModel as string) ?? null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    // Open the add dialog for vm0 — the default model is pre-selected
    store.set(orgOpenAddDialog$, "vm0");

    // Verify the form has a pre-selected model
    const formValues = store.get(orgDialogFormValues$);
    expect(formValues.selectedModel).toBe("claude-sonnet-4-6");

    // Submit WITHOUT changing the model selector (user accepted the default)
    await store.set(orgSubmitDialog$, signal);

    // The selectedModel should be included in the request
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.selectedModel).toBe("claude-sonnet-4-6");
  });

  it("should include selectedModel when user explicitly changes the model", async () => {
    const { store, signal } = context;
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(201, {
          provider: {
            id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
            type: "vm0",
            framework: "claude-code",
            secretName: null,
            authMethod: null,
            secretNames: null,
            isDefault: true,
            selectedModel: (capturedBody.selectedModel as string) ?? null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    // Open the add dialog for vm0
    store.set(orgOpenAddDialog$, "vm0");

    // User explicitly selects a different model
    store.set(orgUpdateFormModel$, "claude-opus-4");

    // Submit
    await store.set(orgSubmitDialog$, signal);

    // The selectedModel should be included in the request
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.selectedModel).toBe("claude-opus-4");
  });

  it("should omit selectedModel when model-first provider policies are enabled", async () => {
    const { store, signal } = context;
    let capturedBody: Record<string, unknown> | null = null;

    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ModelFirstModelProvider]: true },
      withoutRender: true,
    });

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(201, {
          provider: {
            id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
            type: "vm0",
            framework: "claude-code",
            secretName: null,
            authMethod: null,
            secretNames: null,
            isDefault: true,
            selectedModel: null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    store.set(orgOpenAddDialog$, "vm0");

    const formValues = store.get(orgDialogFormValues$);
    expect(formValues.selectedModel).toBe("claude-sonnet-4-6");

    await store.set(orgSubmitDialog$, signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty("selectedModel");
  });

  it("should strip whitespace from single-secret provider tokens before upload", async () => {
    const { store, signal } = context;
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(201, {
          provider: {
            id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
            type: "anthropic-api-key",
            framework: "claude-code",
            secretName: "ANTHROPIC_API_KEY",
            authMethod: null,
            secretNames: null,
            isDefault: true,
            selectedModel: null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    store.set(orgOpenAddDialog$, "anthropic-api-key");
    store.set(orgUpdateFormSecret$, " sk-ant\n test key ");

    await store.set(orgSubmitDialog$, signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.secret).toBe("sk-anttestkey");
  });

  it("should strip whitespace from multi-auth provider secrets before upload", async () => {
    const { store, signal } = context;
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(201, {
          provider: {
            id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
            type: "aws-bedrock",
            framework: "claude-code",
            secretName: null,
            authMethod: "api-key",
            secretNames: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
            isDefault: true,
            selectedModel: null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    store.set(orgOpenAddDialog$, "aws-bedrock");
    store.set(orgUpdateFormAuthMethod$, "api-key");
    store.set(
      orgUpdateFormSecretField$,
      "AWS_BEARER_TOKEN_BEDROCK",
      " bedrock\n token ",
    );
    store.set(orgUpdateFormSecretField$, "AWS_REGION", " us-east-1\n");

    await store.set(orgSubmitDialog$, signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.secrets).toStrictEqual({
      AWS_BEARER_TOKEN_BEDROCK: "bedrocktoken",
      AWS_REGION: "us-east-1",
    });
  });
});
