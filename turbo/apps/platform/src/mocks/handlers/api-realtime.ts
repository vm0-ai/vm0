import { http, HttpResponse } from "msw";

export const apiRealtimeHandlers = [
  http.post("*/api/zero/realtime/token", () => {
    return HttpResponse.json({
      keyName: "mock-key",
      clientId: "test-user-123",
      timestamp: Date.now(),
      capability: '{"*":["*"]}',
      nonce: "mock-nonce",
      mac: "mock-mac",
    });
  }),
];
