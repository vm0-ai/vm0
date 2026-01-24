/**
 * Model Providers API Handlers
 *
 * Mock handlers for /api/model-providers endpoint.
 */

import { http, HttpResponse } from "msw";
import type {
  ModelProviderListResponse,
  ModelProviderResponse,
} from "@vm0/core";

const DUMMY_MODEL_PROVIDER: ModelProviderResponse = {
  id: "dummy-provider",
  type: "claude-code-oauth-token",
  framework: "claude-code",
  credentialName: "CLAUDE_CODE_OAUTH_TOKEN",
  isDefault: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Mock model providers data - empty by default (user has no providers configured)
let mockModelProviders: ModelProviderResponse[] = [DUMMY_MODEL_PROVIDER];

/**
 * Reset mock model providers to default state
 */
export function resetMockModelProviders(): void {
  mockModelProviders = [DUMMY_MODEL_PROVIDER];
}

export const apiModelProvidersHandlers = [
  // GET /api/model-providers - List all model providers
  http.get("/api/model-providers", () => {
    const response: ModelProviderListResponse = {
      modelProviders: mockModelProviders,
    };
    return HttpResponse.json(response);
  }),

  // PUT /api/model-providers - Create or update model provider
  http.put("/api/model-providers", async ({ request }) => {
    const body = (await request.json()) as {
      type: ModelProviderResponse["type"];
      credential: string;
      convert?: boolean;
    };

    const now = new Date().toISOString();
    const existing = mockModelProviders.find((p) => p.type === body.type);
    const created = !existing;

    const provider: ModelProviderResponse = {
      id: existing?.id ?? crypto.randomUUID(),
      type: body.type,
      framework: body.type === "openai-api-key" ? "codex" : "claude-code",
      credentialName:
        body.type === "claude-code-oauth-token"
          ? "CLAUDE_CODE_OAUTH_TOKEN"
          : body.type === "anthropic-api-key"
            ? "ANTHROPIC_API_KEY"
            : "OPENAI_API_KEY",
      isDefault:
        mockModelProviders.length === 0 || existing?.isDefault || false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Update mock data
    if (existing) {
      mockModelProviders = mockModelProviders.map((p) =>
        p.type === body.type ? provider : p,
      );
    } else {
      mockModelProviders.push(provider);
    }

    return HttpResponse.json(
      { provider, created },
      { status: created ? 201 : 200 },
    );
  }),

  // GET /api/model-providers/check/:type - Check if credential exists
  http.get("/api/model-providers/check/:type", ({ params }) => {
    const type = params.type as ModelProviderResponse["type"];
    const existing = mockModelProviders.find((p) => p.type === type);

    const credentialName =
      type === "claude-code-oauth-token"
        ? "CLAUDE_CODE_OAUTH_TOKEN"
        : type === "anthropic-api-key"
          ? "ANTHROPIC_API_KEY"
          : "OPENAI_API_KEY";

    return HttpResponse.json({
      exists: !!existing,
      credentialName,
      ...(existing && { currentType: "model-provider" as const }),
    });
  }),

  // DELETE /api/model-providers/:type - Delete model provider
  http.delete("/api/model-providers/:type", ({ params }) => {
    const type = params.type as ModelProviderResponse["type"];
    const existing = mockModelProviders.find((p) => p.type === type);

    if (!existing) {
      return HttpResponse.json(
        { error: { message: "Model provider not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    mockModelProviders = mockModelProviders.filter((p) => p.type !== type);
    return new HttpResponse(null, { status: 204 });
  }),
];
