/**
 * User Preferences API Handlers
 *
 * Mock handlers for /api/user/preferences endpoint.
 */

import { http, HttpResponse } from "msw";
import type { UserPreferencesResponse } from "@vm0/core";

let mockPreferences: UserPreferencesResponse = {
  timezone: null,
  notifyEmail: false,
  notifySlack: false,
  pinnedAgentIds: [],
};

export function resetMockUserPreferences(): void {
  mockPreferences = {
    timezone: null,
    notifyEmail: false,
    notifySlack: false,
    pinnedAgentIds: [],
  };
}

export const apiUserPreferencesHandlers = [
  // GET /api/user/preferences
  http.get("/api/user/preferences", () => {
    return HttpResponse.json(mockPreferences);
  }),

  // PUT /api/user/preferences
  http.put("/api/user/preferences", async ({ request }) => {
    const body = (await request.json()) as Partial<UserPreferencesResponse>;

    if (body.notifyEmail !== undefined) {
      mockPreferences.notifyEmail = body.notifyEmail;
    }
    if (body.notifySlack !== undefined) {
      mockPreferences.notifySlack = body.notifySlack;
    }
    if (body.timezone !== undefined) {
      mockPreferences.timezone = body.timezone;
    }
    if (body.pinnedAgentIds !== undefined) {
      mockPreferences.pinnedAgentIds = body.pinnedAgentIds;
    }

    return HttpResponse.json(mockPreferences);
  }),
];
