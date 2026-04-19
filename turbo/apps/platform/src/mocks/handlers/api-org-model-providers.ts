/**
 * Org Model Providers API Handlers
 *
 * Mock handlers for /api/zero/model-providers endpoint.
 */

import {
  type ModelProviderResponse,
  zeroModelProvidersDefaultContract,
  zeroModelProvidersMainContract,
  zeroModelProvidersByTypeContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

// Mock org model providers data — empty by default
let mockOrgModelProviders: ModelProviderResponse[] = [];

export function setMockOrgModelProviders(
  providers: ModelProviderResponse[],
): void {
  mockOrgModelProviders = [...providers];
}

/**
 * Reset mock org model providers to default state
 */
export function resetMockOrgModelProviders(): void {
  mockOrgModelProviders = [];
}

export const apiOrgModelProvidersHandlers = [
  // GET /api/zero/model-providers - List all org model providers
  mockApi(zeroModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: mockOrgModelProviders });
  }),

  // POST /api/zero/model-providers - Create or update org model provider
  mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
    const now = new Date().toISOString();
    const existing = mockOrgModelProviders.find((p) => {
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
      isDefault:
        mockOrgModelProviders.length === 0 || existing?.isDefault || false,
      selectedModel: body.selectedModel ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      mockOrgModelProviders = mockOrgModelProviders.map((p) => {
        return p.type === body.type ? provider : p;
      });
    } else {
      mockOrgModelProviders.push(provider);
    }

    return respond(created ? 201 : 200, { provider, created });
  }),

  // POST /api/zero/model-providers/:type/default - Set default provider
  mockApi(
    zeroModelProvidersDefaultContract.setDefault,
    ({ params, respond }) => {
      const existing = mockOrgModelProviders.find((p) => {
        return p.type === params.type;
      });

      if (!existing) {
        return respond(404, {
          error: { message: "Model provider not found", code: "NOT_FOUND" },
        });
      }

      mockOrgModelProviders = mockOrgModelProviders.map((p) => {
        return {
          ...p,
          isDefault: p.type === params.type,
        };
      });

      return respond(200, { ...existing, isDefault: true });
    },
  ),

  // DELETE /api/zero/model-providers/:type - Delete org model provider
  mockApi(zeroModelProvidersByTypeContract.delete, ({ params, respond }) => {
    const existing = mockOrgModelProviders.find((p) => {
      return p.type === params.type;
    });

    if (!existing) {
      return respond(404, {
        error: { message: "Model provider not found", code: "NOT_FOUND" },
      });
    }

    mockOrgModelProviders = mockOrgModelProviders.filter((p) => {
      return p.type !== params.type;
    });
    return respond(204);
  }),
];
