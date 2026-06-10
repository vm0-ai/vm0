import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroUserModelPreferenceContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function putRawModelPreference(body: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/zero/user-model-preference", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

describe("/api/zero/user-model-preference BDD", () => {
  it("requires authentication and an active organization", async () => {
    const client = apiClient();

    const getUnauthenticated = await accept(client.get({ headers: {} }), [401]);
    const updateUnauthenticated = await accept(
      client.update({
        headers: {},
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );

    expect(getUnauthenticated.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
    expect(updateUnauthenticated.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const getNoOrg = await accept(
      client.get({ headers: authHeaders() }),
      [401],
    );
    const updateNoOrg = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );

    expect(getNoOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
    expect(updateNoOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects invalid selections, persists a configured model, and clears the preference", async () => {
    const client = apiClient();
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const defaults = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(defaults.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });

    const missingSelection = await putRawModelPreference("{}");
    const removedModel = await putRawModelPreference(
      JSON.stringify({ selectedModel: "claude-haiku-4-5" }),
    );

    expect(missingSelection.status).toBe(400);
    expect(missingSelection.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(removedModel.status).toBe(400);
    expect(removedModel.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const unconfigured = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-5.4" },
      }),
      [400],
    );

    expect(unconfigured.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });

    const afterRejectedUpdates = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(afterRejectedUpdates.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });

    const selected = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [200],
    );

    expect(selected.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(selected.body.updatedAt).toStrictEqual(expect.any(String));

    const readSelected = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(readSelected.body).toStrictEqual(selected.body);

    const cleared = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: null },
      }),
      [200],
    );
    const readCleared = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(cleared.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
    expect(readCleared.body).toStrictEqual(cleared.body);
  });
});
