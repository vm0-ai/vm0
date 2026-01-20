import { http, HttpResponse } from "msw";

export const webhookHandlers = [
  // POST /api/webhooks/agent/complete - reportPreflightFailure
  http.post("http://localhost:3000/api/webhooks/agent/complete", () => {
    return HttpResponse.json({}, { status: 200 });
  }),
];
