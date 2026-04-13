/**
 * Onboarding API Handlers
 *
 * Mock handlers for /api/zero/onboarding/status endpoint.
 * Default behavior: onboarding is complete (all flags true).
 */

import { http, HttpResponse } from "msw";

export const apiOnboardingHandlers = [
  // GET /api/zero/onboarding/status - Get onboarding status
  http.get("*/api/zero/onboarding/status", () => {
    return HttpResponse.json({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: "c0000000-0000-4000-a000-000000000001",
      defaultAgentMetadata: { displayName: "Zero" },
    });
  }),
];
