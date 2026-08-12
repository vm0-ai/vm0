import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  workerRuntimeProbeContract,
  workerRuntimeProbeRoutes,
} from "../worker-runtime-probe";

const context = testContext();

function probeClient() {
  return setupApp({ context, routes: workerRuntimeProbeRoutes })(
    workerRuntimeProbeContract,
  );
}

describe("POST /api/test/worker-runtime/outbound-safety", () => {
  it("stays unavailable outside preview environments", async () => {
    mockEnv("ENV", "production");
    mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-secret");

    const response = await probeClient().outboundSafety({
      body: {},
      headers: { "x-vm0-test-endpoint-bypass": "test-secret" },
    });

    expect(response.status).toBe(404);
  });

  it("proves private DNS and native fetch blocking in preview", async () => {
    mockEnv("ENV", "preview");
    mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-secret");
    context.mocks.dns.lookupOverrides.set("localtest.me", [
      { address: "127.0.0.1", family: 4 },
    ]);
    server.use(
      http.get("https://localtest.me/", () => {
        return HttpResponse.error();
      }),
    );

    const response = await probeClient().outboundSafety({
      body: {},
      headers: { "x-vm0-test-endpoint-bypass": "test-secret" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      ok: true,
      dns_private_address_blocked: true,
      native_private_fetch_blocked: true,
    });
  });

  it("uses the Worker DNS resolver when deployed to Cloudflare", async () => {
    mockEnv("ENV", "preview");
    mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-secret");
    context.mocks.runtime.setNavigatorUserAgent("Cloudflare-Workers");
    context.mocks.dns.lookupOverrides.set("localtest.me", [
      { address: "198.18.12.62", family: 4 },
    ]);
    let redirect: string | undefined;
    server.use(
      http.get("https://localtest.me/", ({ request }) => {
        redirect = request.redirect;
        return HttpResponse.error();
      }),
    );

    const response = await probeClient().outboundSafety({
      body: {},
      headers: { "x-vm0-test-endpoint-bypass": "test-secret" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      ok: true,
      dns_private_address_blocked: true,
      native_private_fetch_blocked: true,
    });
    expect(redirect).toBe("manual");
  });
});
