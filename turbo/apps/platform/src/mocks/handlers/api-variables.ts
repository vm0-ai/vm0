/**
 * Variables API Handlers
 *
 * Mock handlers for /api/variables endpoint.
 */

import { http, HttpResponse } from "msw";
import type { VariableResponse, VariableListResponse } from "@vm0/core";

let mockVariables: VariableResponse[] = [];

export function resetMockVariables(): void {
  mockVariables = [];
}

export const apiVariablesHandlers = [
  // GET /api/variables - List all variables
  http.get("/api/variables", () => {
    const response: VariableListResponse = {
      variables: mockVariables,
    };
    return HttpResponse.json(response);
  }),

  // PUT /api/variables - Create or update a variable
  http.put("/api/variables", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      value: string;
      description?: string;
    };

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
  }),

  // DELETE /api/variables/:name - Delete a variable
  http.delete("/api/variables/:name", ({ params }) => {
    const name = params.name as string;
    const existing = mockVariables.find((v) => v.name === name);

    if (!existing) {
      return HttpResponse.json(
        { error: { message: "Variable not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    mockVariables = mockVariables.filter((v) => v.name !== name);
    return new HttpResponse(null, { status: 204 });
  }),
];
