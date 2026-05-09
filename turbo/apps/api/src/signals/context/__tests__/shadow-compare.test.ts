import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  mockApiShadowCompareRoutes,
  promoteToApiSource,
  shadowCompareRoute,
} from "../shadow-compare";

const context = testContext();
const c = initContract();

const shadowCompareContract = c.router({
  check: {
    method: "GET",
    path: "/__test/shadow-compare",
    headers: z.object({ authorization: z.string().optional() }),
    responses: {
      200: z.object({
        source: z.enum(["api", "web"]),
      }),
    },
  },
});

const apiHandler$ = computed(() => {
  return {
    status: 200 as const,
    body: { source: "api" as const },
  };
});

describe("shadowCompareRoute", () => {
  it("returns the web response when web is selected", async () => {
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    let observedAuth: string | null = null;
    server.use(
      http.get("https://www.vm0.ai/__test/shadow-compare", ({ request }) => {
        observedAuth = request.headers.get("authorization");
        return HttpResponse.json({ source: "web" });
      }),
    );

    const client = setupApp({
      context,
      routes: [
        {
          route: shadowCompareContract.check,
          handler: shadowCompareRoute({
            route: shadowCompareContract.check,
            handler: apiHandler$,
          }),
        },
      ],
    })(shadowCompareContract);

    const response = await accept(
      client.check({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body).toStrictEqual({ source: "web" });
    expect(observedAuth).toBe("Bearer clerk-session");
  });

  it("returns the api response when api is selected", async () => {
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    mockApiShadowCompareRoutes([shadowCompareContract.check]);
    let comparedWithWeb = false;
    server.use(
      http.get("https://www.vm0.ai/__test/shadow-compare", () => {
        comparedWithWeb = true;
        return HttpResponse.json({ source: "web" });
      }),
    );

    const client = setupApp({
      context,
      routes: [
        {
          route: shadowCompareContract.check,
          handler: shadowCompareRoute({
            route: shadowCompareContract.check,
            handler: apiHandler$,
          }),
        },
      ],
    })(shadowCompareContract);

    const response = await accept(client.check({ headers: {} }), [200]);

    expect(response.body).toStrictEqual({ source: "api" });
    expect(comparedWithWeb).toBeTruthy();
  });
});

describe("promoteToApiSource", () => {
  it("returns the api response when a route is promoted", async () => {
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    promoteToApiSource([shadowCompareContract.check]);
    let comparedWithWeb = false;
    server.use(
      http.get("https://www.vm0.ai/__test/shadow-compare", () => {
        comparedWithWeb = true;
        return HttpResponse.json({ source: "web" });
      }),
    );

    const client = setupApp({
      context,
      routes: [
        {
          route: shadowCompareContract.check,
          handler: shadowCompareRoute({
            route: shadowCompareContract.check,
            handler: apiHandler$,
          }),
        },
      ],
    })(shadowCompareContract);

    const response = await accept(client.check({ headers: {} }), [200]);

    expect(response.body).toStrictEqual({ source: "api" });
    expect(comparedWithWeb).toBeTruthy();
  });
});
