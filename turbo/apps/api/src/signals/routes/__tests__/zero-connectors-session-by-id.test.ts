import { randomUUID } from "node:crypto";

import { zeroConnectorSessionByIdContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { now, nowDate } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

type ConnectorSessionStatus = "pending" | "complete" | "expired" | "error";

async function seedSession(args: {
  readonly userId: string;
  readonly type?: string;
  readonly status?: ConnectorSessionStatus;
  readonly expiresAt?: Date;
  readonly completedAt?: Date;
  readonly errorMessage?: string | null;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(connectorSessions)
    .values({
      code: randomUUID().slice(0, 9).toUpperCase(),
      type: args.type ?? "github",
      userId: args.userId,
      status: args.status ?? "pending",
      expiresAt: args.expiresAt ?? new Date(now() + 15 * 60 * 1000),
      completedAt: args.completedAt,
      errorMessage: args.errorMessage,
    })
    .returning({ id: connectorSessions.id });
  expect(session).toBeDefined();
  return session!.id;
}

describe("GET /api/zero/connectors/:type/sessions/:sessionId", () => {
  const sessionIds: string[] = [];

  afterEach(async () => {
    const db = store.set(writeDb$);
    while (sessionIds.length > 0) {
      const id = sessionIds.pop();
      if (id) {
        await db.delete(connectorSessions).where(eq(connectorSessions.id, id));
      }
    }
  });

  it("returns pending session status", async () => {
    const userId = `user_${randomUUID()}`;
    const sessionId = await seedSession({ userId });
    sessionIds.push(sessionId);
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionByIdContract);
    const response = await accept(
      client.get({
        params: { type: "github", sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("pending");
  });

  it("returns completed session status", async () => {
    const userId = `user_${randomUUID()}`;
    const sessionId = await seedSession({
      userId,
      status: "complete",
      completedAt: nowDate(),
    });
    sessionIds.push(sessionId);
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionByIdContract);
    const response = await accept(
      client.get({
        params: { type: "github", sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("complete");
  });

  it("marks expired pending sessions and returns expired status", async () => {
    const userId = `user_${randomUUID()}`;
    const sessionId = await seedSession({
      userId,
      expiresAt: new Date(now() - 1000),
    });
    sessionIds.push(sessionId);
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionByIdContract);
    const response = await accept(
      client.get({
        params: { type: "github", sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "expired",
      errorMessage: "Session has expired",
    });

    const db = store.set(writeDb$);
    const [session] = await db
      .select({ status: connectorSessions.status })
      .from(connectorSessions)
      .where(eq(connectorSessions.id, sessionId));
    expect(session?.status).toBe("expired");
  });

  it("returns 404 for a missing session", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionByIdContract);
    const response = await accept(
      client.get({
        params: { type: "github", sessionId: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroConnectorSessionByIdContract);
    const response = await accept(
      client.get({
        params: { type: "github", sessionId: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("does not return another user's session", async () => {
    const ownerUserId = `user_${randomUUID()}`;
    const sessionId = await seedSession({ userId: ownerUserId });
    sessionIds.push(sessionId);
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorSessionByIdContract);
    const response = await accept(
      client.get({
        params: { type: "github", sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
