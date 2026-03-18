/**
 * Org API Handlers
 *
 * Mock handlers for /api/org endpoint (org API).
 * Default behavior: user always has an org (for tests that need auth to work).
 */

import { http, HttpResponse } from "msw";
import type { Org } from "../../signals/org.ts";

// Mock org data — default to admin role for development
const mockOrg: Org = {
  id: "org_1",
  slug: "user-12345678",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  role: "admin",
};

export const apiOrgHandlers = [
  // GET /api/org - Get current user's default org
  http.get("/api/org", () => {
    return HttpResponse.json(mockOrg);
  }),
];
