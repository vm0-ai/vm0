import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";

import { POST as createDeviceToken } from "../route";
import { POST as pollDeviceToken } from "../poll/route";
import { server } from "../../../../src/mocks/server";
import { http } from "../../../../src/__tests__/msw";

describe("POST /api/device-token", () => {
  it("forwards device code creation to the api backend", async () => {
    const forwardedBodies: unknown[] = [];
    const handler = http.post(
      "http://localhost:3001/api/device-token",
      async ({ request }) => {
        forwardedBodies.push(await request.json());
        return HttpResponse.json({
          device_code: "ABCD-2345",
          expires_in: 600,
          interval: 3,
          poll_token: "poll_token_123456789012345678901234567890",
        });
      },
    );
    server.use(handler.handler);

    const response = await createDeviceToken(
      new Request("http://localhost:3000/api/device-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device_type: "bb0",
          ble_session_nonce: "bb0-session-nonce-1234",
        }),
      }),
    );

    await expect(response.json()).resolves.toStrictEqual({
      device_code: "ABCD-2345",
      expires_in: 600,
      interval: 3,
      poll_token: "poll_token_123456789012345678901234567890",
    });
    expect(response.status).toBe(200);
    expect(forwardedBodies).toStrictEqual([
      {
        device_type: "bb0",
        ble_session_nonce: "bb0-session-nonce-1234",
      },
    ]);
  });
});

describe("POST /api/device-token/poll", () => {
  it("forwards device code polling to the api backend", async () => {
    const forwardedBodies: unknown[] = [];
    const handler = http.post(
      "http://localhost:3001/api/device-token/poll",
      async ({ request }) => {
        forwardedBodies.push(await request.json());
        return HttpResponse.json(
          {
            status: "pending",
            interval: 3,
          },
          { status: 202 },
        );
      },
    );
    server.use(handler.handler);

    const response = await pollDeviceToken(
      new Request("http://localhost:3000/api/device-token/poll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device_code: "ABCD-2345",
          poll_token: "poll_token_123456789012345678901234567890",
        }),
      }),
    );

    await expect(response.json()).resolves.toStrictEqual({
      status: "pending",
      interval: 3,
    });
    expect(response.status).toBe(202);
    expect(forwardedBodies).toStrictEqual([
      {
        device_code: "ABCD-2345",
        poll_token: "poll_token_123456789012345678901234567890",
      },
    ]);
  });
});
