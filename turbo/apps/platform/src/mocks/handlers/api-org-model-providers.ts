/**
 * Org Model Providers API Handlers
 *
 * Mock handlers for /api/zero/model-providers endpoint.
 */

import { http, HttpResponse } from "msw";
import type {
  ModelProviderListResponse,
  ModelProviderResponse,
} from "@vm0/core";

// Mock org model providers data — empty by default
let mockOrgModelProviders: ModelProviderResponse[] = [];

/**
 * Reset mock org model providers to default state
 */
export function resetMockOrgModelProviders(): void {
  mockOrgModelProviders = [];
}

export const apiOrgModelProvidersHandlers = [
  // GET /api/zero/model-providers - List all org model providers
  http.get("/api/zero/model-providers", () => {
    const response: ModelProviderListResponse = {
      modelProviders: mockOrgModelProviders,
    };
    return HttpResponse.json(response);
  }),

  // POST /api/zero/model-providers - Create or update org model provider
  http.post("/api/zero/model-providers", async ({ request }) => {
    const body = (await request.json()) as {
      type: ModelProviderResponse["type"];
      secret?: string;
      authMethod?: string;
      secrets?: Record<string, string>;
      selectedModel?: string;
    };

    const now = new Date().toISOString();
    const existing = mockOrgModelProviders.find((p) => p.type === body.type);
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
      mockOrgModelProviders = mockOrgModelProviders.map((p) =>
        p.type === body.type ? provider : p,
      );
    } else {
      mockOrgModelProviders.push(provider);
    }

    return HttpResponse.json(
      { provider, created },
      { status: created ? 201 : 200 },
    );
  }),

  // POST /api/zero/model-providers/:type/default - Set default provider
  http.post("/api/zero/model-providers/:type/default", ({ params }) => {
    const type = params.type as ModelProviderResponse["type"];
    const existing = mockOrgModelProviders.find((p) => p.type === type);

    if (!existing) {
      return HttpResponse.json(
        { error: { message: "Model provider not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    mockOrgModelProviders = mockOrgModelProviders.map((p) => ({
      ...p,
      isDefault: p.type === type,
    }));

    return HttpResponse.json({ ...existing, isDefault: true });
  }),

  // DELETE /api/zero/model-providers/:type - Delete org model provider
  http.delete("/api/zero/model-providers/:type", ({ params }) => {
    const type = params.type as ModelProviderResponse["type"];
    const existing = mockOrgModelProviders.find((p) => p.type === type);

    if (!existing) {
      return HttpResponse.json(
        { error: { message: "Model provider not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    mockOrgModelProviders = mockOrgModelProviders.filter(
      (p) => p.type !== type,
    );
    return new HttpResponse(null, { status: 204 });
  }),
];
