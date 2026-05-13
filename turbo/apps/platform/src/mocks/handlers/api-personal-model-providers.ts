import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroPersonalModelProvidersMainContract,
  zeroPersonalModelProvidersByTypeContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { mockApi } from "../msw-contract.ts";

// Mock personal model providers data — empty by default
let mockPersonalModelProviders: ModelProviderResponse[] = [];

export function setMockPersonalModelProviders(
  providers: ModelProviderResponse[],
): void {
  mockPersonalModelProviders = [...providers];
}

/**
 * Reset mock personal model providers to default state
 */
export function resetMockPersonalModelProviders(): void {
  mockPersonalModelProviders = [];
}

export const apiPersonalModelProvidersHandlers = [
  // GET /api/zero/me/model-providers - List the user's personal model providers
  mockApi(zeroPersonalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: mockPersonalModelProviders });
  }),

  // POST /api/zero/me/model-providers - Create or update a personal model provider
  mockApi(
    zeroPersonalModelProvidersMainContract.upsert,
    ({ body, respond }) => {
      const now = new Date().toISOString();
      const existing = mockPersonalModelProviders.find((p) => {
        return p.type === body.type;
      });
      const created = !existing;

      const provider: ModelProviderResponse = {
        id: existing?.id ?? crypto.randomUUID(),
        type: body.type,
        framework: "claude-code",
        secretName:
          body.type === "claude-code-oauth-token"
            ? "CLAUDE_CODE_OAUTH_TOKEN"
            : "ANTHROPIC_API_KEY",
        authMethod: body.authMethod ?? null,
        secretNames: body.secrets ? Object.keys(body.secrets) : null,
        isDefault: existing?.isDefault ?? false,
        selectedModel: body.selectedModel ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        needsReconnect: false,
        lastRefreshErrorCode: null,
      };

      if (existing) {
        mockPersonalModelProviders = mockPersonalModelProviders.map((p) => {
          return p.type === body.type ? provider : p;
        });
      } else {
        mockPersonalModelProviders.push(provider);
      }

      return respond(created ? 201 : 200, { provider, created });
    },
  ),

  // DELETE /api/zero/me/model-providers/:type - Delete a personal model provider
  mockApi(
    zeroPersonalModelProvidersByTypeContract.delete,
    ({ params, respond }) => {
      const existing = mockPersonalModelProviders.find((p) => {
        return p.type === params.type;
      });

      if (!existing) {
        return respond(404, {
          error: { message: "Model provider not found", code: "NOT_FOUND" },
        });
      }

      mockPersonalModelProviders = mockPersonalModelProviders.filter((p) => {
        return p.type !== params.type;
      });
      return respond(204);
    },
  ),
];
