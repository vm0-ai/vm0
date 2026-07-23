import { randomUUID } from "node:crypto";

import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function memoryClient() {
  return setupApp({ context })(zeroMemoryContract);
}

function activityClient() {
  return setupApp({ context })(zeroMemoryActivityContract);
}

function refreshClient() {
  return setupApp({ context })(zeroMemoryDevRefreshContract);
}

describe("retired memory viewer compatibility", () => {
  it("rejects unauthenticated memory reads", async () => {
    const response = await accept(memoryClient().get({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns inert responses to draining browser clients", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    mockEnv("ENV", "development");

    const memory = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(memory.body).toStrictEqual({
      exists: false,
      name: "memory",
      size: 0,
      fileCount: 0,
      updatedAt: null,
      files: [],
      fileContents: [],
    });

    const activity = await accept(
      activityClient().get({
        headers: authHeaders(),
        query: {},
      }),
      [200],
    );
    expect(activity.body).toStrictEqual({
      entries: [],
      nextCursor: null,
    });

    const refresh = await accept(
      refreshClient().refresh({ headers: authHeaders() }),
      [200],
    );
    expect(refresh.body).toStrictEqual({ skipped: true });
  });

  it("keeps the retired refresh endpoint staff-only in production", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    mockEnv("ENV", "production");

    const response = await accept(
      refreshClient().refresh({ headers: authHeaders() }),
      [403],
    ).finally(() => {
      mockEnv("ENV", "development");
    });

    expect(response.body).toStrictEqual({
      error: {
        message: "Memory dev refresh is only available to staff",
        code: "FORBIDDEN",
      },
    });
  });
});
