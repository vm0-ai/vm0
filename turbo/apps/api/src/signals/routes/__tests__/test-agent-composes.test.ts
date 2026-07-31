import { randomUUID } from "node:crypto";

import { testAgentComposesContract } from "@vm0/api-contracts/contracts/test-agent-composes";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { readAgentComposeByIdFixture } from "../../../test-fixtures/agent-composes";
import { generateSandboxToken } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createZeroRouteMocks(context);

function client() {
  return setupApp({ context })(testAgentComposesContract);
}

function authenticate(actor: ApiTestUser): {
  readonly authorization: string;
} {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function composeName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function composeContent(name: string) {
  return {
    version: "1",
    agents: {
      [name]: {
        framework: "claude-code" as const,
      },
    },
  };
}

describe("/api/test/agent-composes", () => {
  it("creates a compose and reads it by name when the endpoint is allowed", async () => {
    mockEnv("ENV", "development");
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    const name = composeName("test-agent-compose");

    const created = await accept(
      client().create({
        headers: authenticate(actor),
        body: { content: composeContent(name) },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      name,
      action: "created",
      composeId: expect.any(String),
      versionId: expect.any(String),
    });

    const byName = await accept(
      client().getByName({
        headers: authenticate(actor),
        query: { name },
      }),
      [200],
    );
    expect(byName.body).toMatchObject({
      id: created.body.composeId,
      name,
      headVersionId: created.body.versionId,
    });

    await expect(
      readAgentComposeByIdFixture({
        actor: { userId: actor.userId, orgId: actor.orgId },
        composeId: created.body.composeId,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { id: created.body.composeId, name },
    });
  });

  it("rejects a malformed create body", async () => {
    mockEnv("ENV", "development");
    const actor = bdd.user();
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/test/agent-composes", {
      method: "POST",
      headers: {
        ...authenticate(actor),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: {
          version: "1",
          agents: [{ framework: "claude-code" }],
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns 404 in production", async () => {
    mockEnv("ENV", "production");
    const actor = bdd.user();
    const name = composeName("production-compose");

    const create = await accept(
      client().create({
        headers: authenticate(actor),
        body: { content: composeContent(name) },
      }),
      [404],
    );
    expect(create.body).toBe("Not found");

    const read = await accept(
      client().getByName({
        headers: authenticate(actor),
        query: { name },
      }),
      [404],
    );
    expect(read.body).toBe("Not found");
  });

  it("rejects sandbox tokens", async () => {
    mockEnv("ENV", "development");
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    const token = generateSandboxToken(actor.userId, randomUUID(), actor.orgId);
    const name = composeName("sandbox-compose");
    const expected = {
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    };

    const create = await accept(
      client().create({
        headers: { authorization: `Bearer ${token}` },
        body: { content: composeContent(name) },
      }),
      [403],
    );
    expect(create.body).toStrictEqual(expected);

    const read = await accept(
      client().getByName({
        headers: { authorization: `Bearer ${token}` },
        query: { name },
      }),
      [403],
    );
    expect(read.body).toStrictEqual(expected);
  });

  it("does not register the retired agent-compose paths", async () => {
    mockEnv("ENV", "development");
    const actor = bdd.user();
    const app = createApp({ signal: context.signal });
    const headers = authenticate(actor);

    const [main, byId, versions] = await Promise.all([
      app.request("/api/agent/composes", { headers }),
      app.request(`/api/agent/composes/${randomUUID()}`, { headers }),
      app.request(
        `/api/agent/composes/versions?composeId=${randomUUID()}&version=latest`,
        { headers },
      ),
    ]);

    expect([main.status, byId.status, versions.status]).toStrictEqual([
      404, 404, 404,
    ]);
  });
});
