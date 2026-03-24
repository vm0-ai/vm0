/**
 * Variables API Handlers
 *
 * Mock handlers for /api/zero/variables endpoints.
 */

import { http, HttpResponse } from "msw";
import type { VariableResponse } from "@vm0/core";

let mockVariables: VariableResponse[] = [];

export function resetMockVariables(): void {
  mockVariables = [];
}

function handleSetVariable(body: {
  name: string;
  value: string;
  description?: string;
}) {
  const now = new Date().toISOString();
  const existing = mockVariables.find((v) => v.name === body.name);
  const created = !existing;

  const variable: VariableResponse = {
    id: existing?.id ?? crypto.randomUUID(),
    name: body.name,
    value: body.value,
    description: body.description ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    mockVariables = mockVariables.map((v) =>
      v.name === body.name ? variable : v,
    );
  } else {
    mockVariables.push(variable);
  }

  return HttpResponse.json(variable, { status: created ? 201 : 200 });
}

export const apiVariablesHandlers = [
  // POST /api/zero/variables - Create or update a variable (zero proxy)
  http.post("/api/zero/variables", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      value: string;
      description?: string;
    };
    return handleSetVariable(body);
  }),
];
