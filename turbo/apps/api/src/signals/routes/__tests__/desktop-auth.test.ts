import { randomUUID } from "node:crypto";

import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { desktopAuthHandoffCodes } from "@vm0/db/schema/desktop-auth-handoff-code";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";

const context = testContext();
const store = createStore();

function handoffClient() {
  return setupApp({ context })(desktopAuthHandoffContract);
}

function consumeClient() {
  return setupApp({ context })(desktopAuthConsumeContract);
}

function authHeaders(token = "clerk-session") {
  return { authorization: `Bearer ${token}` };
}

function mockSession(userId: string): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId: `org_${randomUUID()}`,
        orgRole: "org:admin",
      };
    },
  });
}

function codeFromCallbackUrl(
  callbackUrl: string,
  expectedProtocol = "ai.vm0.zero.desktop:",
): string {
  const url = new URL(callbackUrl);
  expect(url.protocol).toBe(expectedProtocol);
  expect(url.hostname).toBe("auth");
  expect(url.pathname).toBe("/callback");
  return url.searchParams.get("code") ?? "";
}

function handoffIdFromCallbackUrl(callbackUrl: string): string {
  return new URL(callbackUrl).searchParams.get("handoffId") ?? "";
}

function handoffRowsForUser(userId: string) {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select()
    .from(desktopAuthHandoffCodes)
    .where(eq(desktopAuthHandoffCodes.userId, userId));
}

describe("desktop auth routes", () => {
  beforeEach(() => {
    context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
      token: "ticket_desktop_test",
    });
  });

  it("requires a Clerk session to create a handoff code", async () => {
    const response = await accept(
      handoffClient().create({
        body: {},
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates a callback URL without exposing a Clerk ticket", async () => {
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);

    const response = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const code = codeFromCallbackUrl(response.body.callbackUrl);
    expect(code).not.toBe("");
    expect(response.body.callbackUrl).not.toContain("ticket");
    expect(response.body.callbackUrl).not.toContain("token");
    expect(response.body.handoffId).not.toBe("");
    expect(handoffIdFromCallbackUrl(response.body.callbackUrl)).toBe(
      response.body.handoffId,
    );

    const rows = await handoffRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).not.toBe(code);
  });

  it("creates a development callback URL when requested", async () => {
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);

    const response = await accept(
      handoffClient().create({
        body: { callbackScheme: "ai.vm0.zero.desktop.dev" },
        headers: authHeaders(),
      }),
      [200],
    );

    const code = codeFromCallbackUrl(
      response.body.callbackUrl,
      "ai.vm0.zero.desktop.dev:",
    );
    expect(code).not.toBe("");
  });

  it("consumes a handoff code once and returns a short-lived Clerk ticket", async () => {
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);
    const handoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const code = codeFromCallbackUrl(handoff.body.callbackUrl);

    const consumed = await accept(
      consumeClient().consume({
        body: { code },
      }),
      [200],
    );

    expect(consumed.body.token).toBe("ticket_desktop_test");
    expect(
      context.mocks.clerk.signInTokens.createSignInToken,
    ).toHaveBeenCalledWith({
      userId,
      expiresInSeconds: 60,
    });

    const reused = await accept(
      consumeClient().consume({
        body: { code },
      }),
      [400],
    );
    expect(reused.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );
    expect(
      context.mocks.clerk.signInTokens.createSignInToken,
    ).toHaveBeenCalledTimes(1);
  });

  it("reports handoff status for the creating user only", async () => {
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);
    const handoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );

    const pending = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(pending.body.status).toBe("pending");

    mockSession(`user_desktop_${randomUUID()}`);
    const otherUser = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherUser.body.error.code).toBe("NOT_FOUND");
  });

  it("marks a consumed handoff complete", async () => {
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);
    const handoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const code = codeFromCallbackUrl(handoff.body.callbackUrl);

    await accept(
      consumeClient().consume({
        body: { code },
      }),
      [200],
    );
    const consumed = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(consumed.body.status).toBe("consumed");

    const completed = await accept(
      handoffClient().complete({
        params: { handoffId: handoff.body.handoffId },
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(completed.body.status).toBe("completed");

    const status = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(status.body.status).toBe("completed");
  });

  it("does not complete an unconsumed handoff", async () => {
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);
    const handoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );

    const completed = await accept(
      handoffClient().complete({
        params: { handoffId: handoff.body.handoffId },
        body: {},
        headers: authHeaders(),
      }),
      [404],
    );
    expect(completed.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects expired handoff codes", async () => {
    const createdAt = new Date("2026-05-18T00:00:00.000Z");
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);
    mockNow(createdAt);
    const handoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const code = codeFromCallbackUrl(handoff.body.callbackUrl);
    mockNow(new Date(createdAt.getTime() + 61_000));

    const response = await accept(
      consumeClient().consume({
        body: { code },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );
  });
});
