/**
 * Onboarding API Handlers
 *
 * Mock handlers for /api/onboarding/status endpoint.
 * Default behavior: onboarding is complete (all flags true).
 */

import { http, HttpResponse } from "msw";

export const apiOnboardingHandlers = [
  // GET /api/onboarding/status - Get onboarding status
  http.get("/api/onboarding/status", () => {
    return HttpResponse.json({
      needsOnboarding: false,
      hasScope: true,
      hasModelProvider: true,
      hasDefaultAgent: true,
      defaultAgentName: "zero",
      defaultAgentComposeId: "mock-compose-id",
    });
  }),
];
