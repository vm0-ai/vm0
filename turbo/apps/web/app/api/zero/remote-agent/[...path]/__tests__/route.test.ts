import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";

import { DELETE, GET, POST } from "../route";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";

describe("/api/zero/remote-agent/*", () => {
  it("forwards POST requests to the api backend", async () => {
    const forwardedBodies: unknown[] = [];
    const forwardedHeaders: Headers[] = [];
    const handler = http.post(
      "http://localhost:3001/api/zero/remote-agent/device/start",
      async ({ request }) => {
        forwardedBodies.push(await request.json());
        forwardedHeaders.push(request.headers);
        return HttpResponse.json({
          deviceCode: "ABCD-2345",
          userCode: "ABCD-2345",
          verificationPath: "/zero/connectors/remote-agent",
          expiresIn: 900,
          interval: 5,
          pollToken: "vm0_remote_poll_test",
        });
      },
    );
    server.use(handler.handler);

    const response = await POST(
      new Request("http://localhost:3000/api/zero/remote-agent/device/start", {
        method: "POST",
        headers: {
          authorization: "Bearer cli-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostName: "local-host",
          supportedBackends: ["codex"],
        }),
      }),
    );

    await expect(response.json()).resolves.toStrictEqual({
      deviceCode: "ABCD-2345",
      userCode: "ABCD-2345",
      verificationPath: "/zero/connectors/remote-agent",
      expiresIn: 900,
      interval: 5,
      pollToken: "vm0_remote_poll_test",
    });
    expect(response.status).toBe(200);
    expect(forwardedBodies).toStrictEqual([
      {
        hostName: "local-host",
        supportedBackends: ["codex"],
      },
    ]);
    expect(forwardedHeaders[0]?.get("authorization")).toBe("Bearer cli-token");
  });

  it("forwards GET requests with path params and query string", async () => {
    const forwardedUrls: string[] = [];
    const handler = http.get(
      "http://localhost:3001/api/zero/remote-agent/run/job-123",
      ({ request }) => {
        forwardedUrls.push(request.url);
        return HttpResponse.json({
          id: "job-123",
          hostId: "host-123",
          backend: "codex",
          prompt: "hello",
          status: "succeeded",
          output: "done",
          error: null,
          exitCode: 0,
          createdAt: "2026-05-11T00:00:00.000Z",
          startedAt: "2026-05-11T00:00:01.000Z",
          completedAt: "2026-05-11T00:00:02.000Z",
        });
      },
    );
    server.use(handler.handler);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/zero/remote-agent/run/job-123?trace=1",
        {
          method: "GET",
          headers: {
            authorization: "Bearer cli-token",
          },
        },
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      id: "job-123",
      status: "succeeded",
    });
    expect(response.status).toBe(200);
    expect(forwardedUrls).toStrictEqual([
      "http://localhost:3001/api/zero/remote-agent/run/job-123?trace=1",
    ]);
  });

  it("forwards DELETE requests", async () => {
    const forwardedUrls: string[] = [];
    const handler = http.delete(
      "http://localhost:3001/api/zero/remote-agent/hosts/host-123",
      ({ request }) => {
        forwardedUrls.push(request.url);
        return HttpResponse.json({ ok: true });
      },
    );
    server.use(handler.handler);

    const response = await DELETE(
      new Request(
        "http://localhost:3000/api/zero/remote-agent/hosts/host-123",
        {
          method: "DELETE",
          headers: {
            authorization: "Bearer cli-token",
          },
        },
      ),
    );

    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(forwardedUrls).toStrictEqual([
      "http://localhost:3001/api/zero/remote-agent/hosts/host-123",
    ]);
  });
});
