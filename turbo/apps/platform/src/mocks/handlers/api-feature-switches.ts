/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 */

import { http, HttpResponse } from "msw";

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
  // GET /api/zero/feature-switches
  http.get("*/api/zero/feature-switches", () => {
    return HttpResponse.json({ switches: mockSwitches });
  }),

  // POST /api/zero/feature-switches
  http.post("*/api/zero/feature-switches", async ({ request }) => {
    const body = (await request.json()) as {
      switches: Record<string, boolean>;
    };
    mockSwitches = { ...mockSwitches, ...body.switches };
    return HttpResponse.json({ switches: mockSwitches });
  }),
];
