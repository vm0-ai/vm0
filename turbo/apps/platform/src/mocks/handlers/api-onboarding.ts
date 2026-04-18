/**
 * Onboarding API Handlers
 *
 * Mock handlers for /api/zero/onboarding/status endpoint.
 * Default behavior: onboarding is complete (all flags true).
 */

import { onboardingStatusContract } from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

export const apiOnboardingHandlers = [
  mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: "c0000000-0000-4000-a000-000000000001",
      defaultAgentMetadata: { displayName: "Zero" },
    });
  }),
];
