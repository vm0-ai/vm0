import { randomUUID } from "node:crypto";

import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { desktopAuthHandoffCodes } from "@vm0/db/schema/desktop-auth-handoff-code";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";

// BDD migration of the legacy `desktop-auth.test.ts`. The 8
// legacy `it()`s collapse into 3 BDD `it()`s: (1) create chain
// (401 unauth → 200 creates a callback URL with no Clerk ticket
// + DB row exists → 200 creates a dev callback URL when
// requested), (2) consume chain (200 consumes a handoff code +
// Clerk ticket + reuse returns 400 → 400 expired handoff code),
// (3) status + complete chain (200 reports pending for the
// creating user + 404 for another user → 200 marks a consumed
// handoff complete → 404 cannot complete an unconsumed handoff).
//
// Service-Level Exception: post-create state is verified via
// direct DB reads against `desktop_auth_handoff_codes` because
// no follow-up GET endpoint for a single handoff exists.

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

describe("BDD desktop-auth — create chain", () => {
  beforeEach(() => {
    context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
      token: "ticket_desktop_test",
    });
  });

  it("gwt-wt-wt: 401 unauth → 200 creates a callback URL with no Clerk ticket + DB row exists → 200 creates a dev callback URL when requested", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      handoffClient().create({
        body: {},
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a Clerk session for a user.
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);

    // When: create a handoff.
    const created = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );

    // Then: a callback URL is returned with no Clerk ticket +
    // the DB row exists.
    const code = codeFromCallbackUrl(created.body.callbackUrl);
    expect(code).not.toBe("");
    expect(created.body.callbackUrl).not.toContain("ticket");
    expect(created.body.callbackUrl).not.toContain("token");
    expect(created.body.handoffId).not.toBe("");
    expect(handoffIdFromCallbackUrl(created.body.callbackUrl)).toBe(
      created.body.handoffId,
    );
    const rows = await handoffRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).not.toBe(code);

    // Given: a fresh user session.
    const devUserId = `user_desktop_${randomUUID()}`;
    mockSession(devUserId);

    // When + Then: a development callback URL is created when
    // the dev scheme is requested.
    const dev = await accept(
      handoffClient().create({
        body: { callbackScheme: "ai.vm0.zero.desktop.dev" },
        headers: authHeaders(),
      }),
      [200],
    );
    const devCode = codeFromCallbackUrl(
      dev.body.callbackUrl,
      "ai.vm0.zero.desktop.dev:",
    );
    expect(devCode).not.toBe("");
  });
});

describe("BDD desktop-auth — consume chain", () => {
  beforeEach(() => {
    context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
      token: "ticket_desktop_test",
    });
  });

  it("gwt-wt-wt: 200 consumes a handoff code + returns a short-lived Clerk ticket + reuse returns 400 → 400 expired handoff code", async () => {
    // Given: a fresh user + a handoff.
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

    // When: consume the handoff.
    const consumed = await accept(
      consumeClient().consume({
        body: { code },
      }),
      [200],
    );

    // Then: the Clerk ticket is returned + signInTokens.create
    // was called with the right args.
    expect(consumed.body.token).toBe("ticket_desktop_test");
    expect(
      context.mocks.clerk.signInTokens.createSignInToken,
    ).toHaveBeenCalledWith({
      userId,
      expiresInSeconds: 60,
    });

    // When + Then: reusing the same code returns 400 + the
    // ticket was only created once.
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

    // Given: a fresh user + a handoff created at t0; the clock
    // has moved 61s forward.
    const createdAt = new Date("2026-05-18T00:00:00.000Z");
    const expiredUserId = `user_desktop_${randomUUID()}`;
    mockSession(expiredUserId);
    mockNow(createdAt);
    const expiredHandoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const expiredCode = codeFromCallbackUrl(expiredHandoff.body.callbackUrl);
    mockNow(new Date(createdAt.getTime() + 61_000));

    // When + Then: 400 — the handoff is expired.
    const expired = await accept(
      consumeClient().consume({
        body: { code: expiredCode },
      }),
      [400],
    );
    expect(expired.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );
  });
});

describe("BDD desktop-auth — status + complete chain", () => {
  beforeEach(() => {
    context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
      token: "ticket_desktop_test",
    });
  });

  it("gwt-wt-wt: 200 reports pending for the creating user + 404 for another user → 200 marks a consumed handoff complete → 404 cannot complete an unconsumed handoff", async () => {
    // Given: a fresh user + a handoff.
    const userId = `user_desktop_${randomUUID()}`;
    mockSession(userId);
    const handoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );

    // When + Then: the creating user can read the status
    // (pending).
    const pending = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(pending.body.status).toBe("pending");

    // Given: a different user session.
    mockSession(`user_desktop_${randomUUID()}`);

    // When + Then: another user gets 404.
    const otherUser = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherUser.body.error.code).toBe("NOT_FOUND");

    // Given: the original user's handoff is consumed.
    mockSession(userId);
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

    // When + Then: the creating user marks the consumed
    // handoff complete.
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

    // Given: a fresh user + a fresh handoff that has not been
    // consumed.
    const newUserId = `user_desktop_${randomUUID()}`;
    mockSession(newUserId);
    const freshHandoff = await accept(
      handoffClient().create({
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );

    // When + Then: 404 — cannot complete an unconsumed
    // handoff.
    const notFound = await accept(
      handoffClient().complete({
        params: { handoffId: freshHandoff.body.handoffId },
        body: {},
        headers: authHeaders(),
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });
});
