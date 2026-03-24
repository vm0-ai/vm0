/**
 * Secrets API Handlers
 *
 * Mock handlers for /api/zero/secrets endpoints.
 */

import { http, HttpResponse } from "msw";
import type { SecretResponse } from "@vm0/core";

let mockSecrets: SecretResponse[] = [];

export function resetMockSecrets(): void {
  mockSecrets = [];
}

function handleSetSecret(body: {
  name: string;
  value: string;
  description?: string;
}) {
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
}

export const apiSecretsHandlers = [
  // POST /api/zero/secrets - Create or update a secret (zero proxy)
  http.post("/api/zero/secrets", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      value: string;
      description?: string;
    };
    return handleSetSecret(body);
  }),
];
