import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";

import { POST } from "../route";
import { server } from "../../../../../../../src/mocks/server";
import { http } from "../../../../../../../src/__tests__/msw";

describe("POST /api/zero/devices/bb0/confirm", () => {
  it("forwards the confirmation request to the api backend", async () => {
    const forwardedBodies: unknown[] = [];
    const forwardedHeaders: Headers[] = [];
    const handler = http.post(
      "http://localhost:3001/api/zero/devices/bb0/confirm",
      async ({ request }) => {
        forwardedBodies.push(await request.json());
        forwardedHeaders.push(request.headers);
        return HttpResponse.json(
          { status: "approved" },
          {
            status: 200,
            headers: {
              "x-api-service": "api",
            },
          },
        );
      },
    );
    server.use(handler.handler);

    const response = await POST(
      new Request("http://localhost:3000/api/zero/devices/bb0/confirm", {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          cookie: "__session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_code: "ABCD-2345" }),
      }),
    );

    await expect(response.json()).resolves.toStrictEqual({
      status: "approved",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-api-service")).toBe("api");
    expect(forwardedBodies).toStrictEqual([{ device_code: "ABCD-2345" }]);
    expect(forwardedHeaders[0]?.get("authorization")).toBe(
      "Bearer clerk-session",
    );
    expect(forwardedHeaders[0]?.get("cookie")).toBe("__session=session-token");
  });

  it("preserves the upstream status and body", async () => {
    const handler = http.post(
      "http://localhost:3001/api/zero/devices/bb0/confirm",
      () => {
        return HttpResponse.json(
          {
            error: {
              message: "Device code not found or expired",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      },
    );
    server.use(handler.handler);

    const response = await POST(
      new Request("http://localhost:3000/api/zero/devices/bb0/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_code: "ABCD-2345" }),
      }),
    );

    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Device code not found or expired",
        code: "NOT_FOUND",
      },
    });
    expect(response.status).toBe(404);
  });
});
