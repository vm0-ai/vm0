/**
 * Slack Connect API Handlers
 *
 * Mock handlers for /api/zero/integrations/slack/connect endpoint.
 * Default behavior: user is not yet connected.
 */

import { http, HttpResponse } from "msw";

interface MockSlackConnectData {
  isConnected: boolean;
  postError: string | null;
}

let mockData: MockSlackConnectData = {
  isConnected: false,
  postError: null,
};

export function setMockSlackConnectData(
  data: Partial<MockSlackConnectData>,
): void {
  mockData = { ...mockData, ...data };
}

export function resetMockSlackConnect(): void {
  mockData = {
    isConnected: false,
    postError: null,
  };
}

export const apiIntegrationsSlackConnectHandlers = [
  // GET /api/zero/integrations/slack/connect — check connection status
  http.get("*/api/zero/integrations/slack/connect", () => {
    return HttpResponse.json({ isConnected: mockData.isConnected });
  }),

  // POST /api/zero/integrations/slack/connect — connect account
  http.post("*/api/zero/integrations/slack/connect", () => {
    if (mockData.postError) {
      return HttpResponse.json(
        { error: { message: mockData.postError } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ ok: true });
  }),
];
