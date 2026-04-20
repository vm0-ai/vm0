/**
 * Onboarding API Handlers
 *
 * Mock handlers for /api/zero/onboarding endpoints.
 * Default behavior: onboarding is complete (all flags true).
 */

import {
  onboardingStatusContract,
  onboardingSetupContract,
  onboardingCompleteContract,
  type OnboardingStatusResponse,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_ONBOARDING_STATUS: OnboardingStatusResponse = {
  needsOnboarding: false,
  isAdmin: true,
  hasOrg: true,
  hasDefaultAgent: true,
  defaultAgentId: "c0000000-0000-4000-a000-000000000001",
  defaultAgentMetadata: { displayName: "Zero" },
};

let mockOnboardingStatus: OnboardingStatusResponse = {
  ...DEFAULT_ONBOARDING_STATUS,
};

export function setMockOnboardingStatus(
  status: Partial<OnboardingStatusResponse>,
): void {
  mockOnboardingStatus = { ...mockOnboardingStatus, ...status };
}

export function resetMockOnboardingStatus(): void {
  mockOnboardingStatus = { ...DEFAULT_ONBOARDING_STATUS };
}

export const apiOnboardingHandlers = [
  // GET /api/zero/onboarding/status
  mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, mockOnboardingStatus);
  }),

  // POST /api/zero/onboarding/setup
  mockApi(onboardingSetupContract.setup, ({ respond }) => {
    return respond(200, { agentId: "d0000000-0000-4000-a000-000000000001" });
  }),

  // POST /api/zero/onboarding/complete
  mockApi(onboardingCompleteContract.complete, ({ respond }) => {
    return respond(200, { ok: true });
  }),
];
