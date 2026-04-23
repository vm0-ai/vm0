/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 */

import { zeroFeatureSwitchesContract } from "@vm0/core/contracts/zero-feature-switches";

import { mockApi } from "../msw-contract.ts";

let mockSwitches: Record<string, boolean> = {};

export function resetMockFeatureSwitches(): void {
  mockSwitches = {};
}

export function setMockFeatureSwitches(
  switches: Partial<Record<string, boolean>>,
): void {
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(switches)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  mockSwitches = next;
}

export function getMockFeatureSwitches(): Record<string, boolean> {
  return mockSwitches;
}

export const apiFeatureSwitchesHandlers = [
  mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: mockSwitches });
  }),

  mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
    mockSwitches = { ...mockSwitches, ...body.switches };
    return respond(200, { switches: mockSwitches });
  }),

  mockApi(zeroFeatureSwitchesContract.delete, ({ respond }) => {
    mockSwitches = {};
    return respond(200, { deleted: true as const });
  }),
];
