/**
 * User Preferences API Handlers
 *
 * Mock handlers for /api/zero/user-preferences endpoint.
 */

import { http, HttpResponse } from "msw";
import type { UserPreferencesResponse } from "@vm0/core";

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
  // GET /api/zero/user-preferences
  http.get("*/api/zero/user-preferences", () => {
    return HttpResponse.json(mockPreferences);
  }),

  // POST /api/zero/user-preferences
  http.post("*/api/zero/user-preferences", async ({ request }) => {
    const body = (await request.json()) as Partial<UserPreferencesResponse>;

    if (body.timezone !== undefined) {
      mockPreferences.timezone = body.timezone;
    }
    if (body.pinnedAgentIds !== undefined) {
      mockPreferences.pinnedAgentIds = body.pinnedAgentIds;
    }
    if (body.sendMode !== undefined) {
      mockPreferences.sendMode = body.sendMode;
    }
    if (body.captureNetworkBodiesRemaining !== undefined) {
      mockPreferences.captureNetworkBodiesRemaining =
        body.captureNetworkBodiesRemaining;
    }

    return HttpResponse.json(mockPreferences);
  }),
];
