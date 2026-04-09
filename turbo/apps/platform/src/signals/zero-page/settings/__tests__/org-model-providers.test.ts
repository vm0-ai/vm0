import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import {
  orgOpenAddDialog$,
  orgSubmitDialog$,
  orgDialogFormValues$,
  orgFormErrors$,
  orgUpdateFormModel$,
} from "../org-model-providers.ts";
import { getProviderShape } from "../../../../views/zero-page/components/settings/provider-ui-config.ts";

const context = testContext();

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
      http.post("*/api/zero/model-providers", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: (capturedBody.selectedModel as string) ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
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
      http.post("*/api/zero/model-providers", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: (capturedBody.selectedModel as string) ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
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
      http.post("*/api/zero/model-providers", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: (capturedBody.selectedModel as string) ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
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
});
