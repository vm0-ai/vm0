/**
 * Org API Handlers
 *
 * Mock handlers for /api/zero/org endpoint (org API via zero layer).
 * Default behavior: user always has an org (for tests that need auth to work).
 */

import { http, HttpResponse } from "msw";
import type { Org } from "../../signals/org.ts";

// Mock org data — default to admin role for development
const mockOrg: Org = {
  id: "org_1",
  slug: "user-12345678",
  name: "User 12345678",
  role: "admin",
};

export const apiOrgHandlers = [
  // GET /api/zero/org - Get current user's default org (zero proxy)
  http.get("*/api/zero/org", () => {
    return HttpResponse.json(mockOrg);
  }),
];
