/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 */

import { zeroFeatureSwitchesContract } from "@vm0/core";

import { mockApi } from "../msw-contract.ts";

let mockSwitches: Record<string, boolean> = {};

export function resetMockFeatureSwitches(): void {
  mockSwitches = {};
}

export function setMockFeatureSwitches(
  switches: Record<string, boolean>,
): void {
  mockSwitches = { ...switches };
}

export const apiFeatureSwitchesHandlers = [
  mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: mockSwitches });
  }),

  mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
    mockSwitches = { ...mockSwitches, ...body.switches };
    return respond(200, { switches: mockSwitches });
  }),
];
