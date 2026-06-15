import {
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
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
