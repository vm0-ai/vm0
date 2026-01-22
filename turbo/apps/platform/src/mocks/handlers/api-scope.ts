/**
 * Scope API Handlers
 *
 * Mock handlers for /api/scope endpoint.
 * Default behavior: user always has a scope (for tests that need auth to work).
 */

import { http, HttpResponse } from "msw";
import type { Scope } from "../../signals/scope.ts";

// Mock scope data
const mockScope: Scope = {
  id: "scope_1",
  slug: "user-12345678",
  type: "personal",
  displayName: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

export const apiScopeHandlers = [
  // GET /api/scope - Get current user's scope
  http.get("/api/scope", () => {
    return HttpResponse.json(mockScope);
  }),

  // POST /api/scope - Create user's scope
  // Always returns 409 since mock user always has scope
  http.post("/api/scope", () => {
    return HttpResponse.json(
      { error: { message: "You already have a scope", code: "CONFLICT" } },
      { status: 409 },
    );
  }),
];
