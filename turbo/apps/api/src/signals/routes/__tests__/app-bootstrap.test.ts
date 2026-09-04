import { randomUUID } from "node:crypto";

import { appBootstrapContract } from "@okouai/api-contracts/contracts/app-bootstrap";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { appBootstrapRoutes } from "../app-bootstrap";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function client() {
  return setupApp({ context, routes: appBootstrapRoutes })(
    appBootstrapContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("GET /api/bootstrap", () => {
  it("returns the initial agent-chat responses", async () => {
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );

    const response = await accept(
      client().get({
        headers: authHeaders(),
        query: {
          path: "/agents/agent-1/chat?__bootstrap=1&keep=value",
        },
      }),
      [200],
    );

    expect(response.body.responses).toStrictEqual([
      {
        method: "GET",
        path: featureSwitchesContract.get.path,
        contentType: "application/json",
        body: expect.objectContaining({
          switches: expect.any(Object),
          effectiveSwitches: expect.any(Object),
        }),
      },
      {
        method: "GET",
        path: agentsMainContract.list.path,
        contentType: "application/json",
        body: [],
      },
    ]);
  });

  it("allows unsupported pages to fall through to regular API requests", async () => {
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );

    const response = await accept(
      client().get({
        headers: authHeaders(),
        query: { path: "/settings/profile?__bootstrap=1" },
      }),
      [200],
    );

    expect(response.body.responses).toStrictEqual([]);
  });

  it("requires an authenticated organization session", async () => {
    const response = await accept(
      client().get({
        headers: {},
        query: { path: "/agents/agent-1/chat" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
