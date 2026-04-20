/**
 * User Preferences API Handlers
 *
 * Mock handlers for /api/zero/user-preferences endpoint.
 */

import {
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockPreferences: UserPreferencesResponse = {
  timezone: null,
  pinnedAgentIds: [],
  sendMode: "enter",
  captureNetworkBodiesRemaining: 0,
};

export function resetMockUserPreferences(): void {
  mockPreferences = {
    timezone: null,
    pinnedAgentIds: [],
    sendMode: "enter",
    captureNetworkBodiesRemaining: 0,
  };
}

export function setMockUserPreferences(
  overrides: Partial<UserPreferencesResponse>,
): void {
  mockPreferences = { ...mockPreferences, ...overrides };
}

export const apiUserPreferencesHandlers = [
  mockApi(zeroUserPreferencesContract.get, ({ respond }) => {
    return respond(200, mockPreferences);
  }),
  mockApi(zeroUserPreferencesContract.update, ({ body, respond }) => {
    Object.assign(mockPreferences, body);
    return respond(200, mockPreferences);
  }),
];
