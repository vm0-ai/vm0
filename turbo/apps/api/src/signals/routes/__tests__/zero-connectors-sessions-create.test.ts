import { randomUUID } from "node:crypto";

import { zeroConnectorSessionsContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("POST /api/zero/connectors/:type/sessions", () => {
  const sessionIds: string[] = [];

  afterEach(async () => {
    const db = store.set(writeDb$);
    while (sessionIds.length > 0) {
      const sessionId = sessionIds.pop();
      if (sessionId) {
        await db
          .delete(connectorSessions)
          .where(eq(connectorSessions.id, sessionId));
      }
    }
  });

  it("creates a pending connector session", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionsContract);
    const response = await accept(
      client.create({
        params: { type: "github" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    sessionIds.push(response.body.id);

    expect(response.body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(response.body.type).toBe("github");
    expect(response.body.status).toBe("pending");
    expect(response.body.verificationUrl).toContain(
      "/api/connectors/github/authorize",
    );
    expect(response.body.verificationUrl).toContain(
      `session=${response.body.id}`,
    );
    expect(response.body.expiresIn).toBe(900);
    expect(response.body.interval).toBe(5);

    const db = store.set(writeDb$);
    const [session] = await db
      .select({
        code: connectorSessions.code,
        type: connectorSessions.type,
        authMethod: connectorSessions.authMethod,
        userId: connectorSessions.userId,
        status: connectorSessions.status,
      })
      .from(connectorSessions)
      .where(eq(connectorSessions.id, response.body.id));
    expect(session).toStrictEqual({
      code: response.body.code,
      type: "github",
      authMethod: "oauth",
      userId,
      status: "pending",
    });
  });

  it("rejects feature-disabled connector sessions without creating a row", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionsContract);
    const response = await accept(
      client.create({
        params: { type: "docusign" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "docusign connector is not available",
      code: "FORBIDDEN",
    });

    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: connectorSessions.id })
      .from(connectorSessions)
      .where(
        and(
          eq(connectorSessions.userId, userId),
          eq(connectorSessions.type, "docusign"),
        ),
      );
    expect(rows).toStrictEqual([]);
  });

  it("rejects connector sessions for connectors without an auth-code grant", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionsContract);
    const response = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "test-oauth-device connector does not use an auth-code grant",
      code: "BAD_REQUEST",
    });

    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: connectorSessions.id })
      .from(connectorSessions)
      .where(
        and(
          eq(connectorSessions.userId, userId),
          eq(connectorSessions.type, "test-oauth-device"),
        ),
      );
    expect(rows).toStrictEqual([]);
  });

  it("rejects connector sessions for a missing selected auth method", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionsContract);
    const response = await accept(
      client.create({
        params: { type: "github" },
        body: { authMethod: "api-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "github connector does not have api-token auth method",
      code: "BAD_REQUEST",
    });

    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: connectorSessions.id })
      .from(connectorSessions)
      .where(
        and(
          eq(connectorSessions.userId, userId),
          eq(connectorSessions.type, "github"),
        ),
      );
    expect(rows).toStrictEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroConnectorSessionsContract);
    const response = await accept(
      client.create({
        params: { type: "github" },
        body: { authMethod: "oauth" },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorSessionsContract);
    const response = await accept(
      client.create({
        params: { type: "github" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
