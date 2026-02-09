/**
 * Secrets API Handlers
 *
 * Mock handlers for /api/secrets endpoint.
 */

import { http, HttpResponse } from "msw";
import type { SecretResponse, SecretListResponse } from "@vm0/core";

let mockSecrets: SecretResponse[] = [];

export function resetMockSecrets(): void {
  mockSecrets = [];
}

export const apiSecretsHandlers = [
  // GET /api/secrets - List all secrets
  http.get("/api/secrets", () => {
    const response: SecretListResponse = {
      secrets: mockSecrets,
    };
    return HttpResponse.json(response);
  }),

  // PUT /api/secrets - Create or update a secret
  http.put("/api/secrets", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      value: string;
      description?: string;
    };

    const now = new Date().toISOString();
    const existing = mockSecrets.find((s) => s.name === body.name);
    const created = !existing;

    const secret: SecretResponse = {
      id: existing?.id ?? crypto.randomUUID(),
      name: body.name,
      description: body.description ?? null,
      type: "user",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      mockSecrets = mockSecrets.map((s) => (s.name === body.name ? secret : s));
    } else {
      mockSecrets.push(secret);
    }

    return HttpResponse.json(secret, { status: created ? 201 : 200 });
  }),

  // DELETE /api/secrets/:name - Delete a secret
  http.delete("/api/secrets/:name", ({ params }) => {
    const name = params.name as string;
    const existing = mockSecrets.find((s) => s.name === name);

    if (!existing) {
      return HttpResponse.json(
        { error: { message: "Secret not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    mockSecrets = mockSecrets.filter((s) => s.name !== name);
    return new HttpResponse(null, { status: 204 });
  }),
];
