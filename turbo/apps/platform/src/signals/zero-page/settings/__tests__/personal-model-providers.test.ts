import { describe, expect, it } from "vitest";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { server } from "../../../../mocks/server.ts";
import { createMockApi } from "../../../../mocks/msw-contract.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import {
  personalOpenOAuthCredentialDialog$,
  personalSubmitDialog$,
  personalUpdateFormSecret$,
} from "../personal-model-providers.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("personal-model-providers", () => {
  it("strips whitespace from personal model provider tokens before upload", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      mockApi(
        zeroPersonalModelProvidersMainContract.upsert,
        ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(201, {
            provider: {
              id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
              type: "claude-code-oauth-token",
              framework: "claude-code",
              secretName: "CLAUDE_CODE_OAUTH_TOKEN",
              authMethod: null,
              secretNames: null,
              isDefault: false,
              selectedModel: null,
              needsReconnect: false,
              lastRefreshErrorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          });
        },
      ),
    );

    context.store.set(
      personalOpenOAuthCredentialDialog$,
      "claude-code-oauth-token",
    );
    context.store.set(personalUpdateFormSecret$, " sk-ant-oat01\n test token ");

    await context.store.set(personalSubmitDialog$, context.signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.secret).toBe("sk-ant-oat01testtoken");
  });
});
