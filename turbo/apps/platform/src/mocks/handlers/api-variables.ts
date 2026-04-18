/**
 * Variables API Handlers
 *
 * Mock handlers for /api/zero/variables endpoints.
 */

import { zeroVariablesContract, type VariableResponse } from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockVariables: VariableResponse[] = [];

export function resetMockVariables(): void {
  mockVariables = [];
}

export const apiVariablesHandlers = [
  mockApi(zeroVariablesContract.set, ({ body, respond }) => {
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

    return respond(created ? 201 : 200, variable);
  }),
];
