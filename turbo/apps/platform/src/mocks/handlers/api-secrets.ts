/**
 * Secrets API Handlers
 *
 * Mock handlers for /api/zero/secrets endpoints.
 */

import { zeroSecretsContract } from "@vm0/core/contracts/zero-secrets";
import type { SecretResponse } from "@vm0/core/contracts/secrets";
import { mockApi } from "../msw-contract.ts";

let mockSecrets: SecretResponse[] = [];

export function resetMockSecrets(): void {
  mockSecrets = [];
}

export const apiSecretsHandlers = [
  mockApi(zeroSecretsContract.set, ({ body, respond }) => {
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

    return respond(created ? 201 : 200, secret);
  }),
];
