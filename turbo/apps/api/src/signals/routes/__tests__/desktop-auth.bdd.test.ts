import { randomUUID } from "node:crypto";

import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";

const context = testContext();

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

function callbackParts(
  callbackUrl: string,
  expectedProtocol = "ai.vm0.zero.desktop:",
): { readonly code: string; readonly handoffId: string } {
  const url = new URL(callbackUrl);
  expect(url.protocol).toBe(expectedProtocol);
  expect(url.hostname).toBe("auth");
  expect(url.pathname).toBe("/callback");
  return {
    code: url.searchParams.get("code") ?? "",
    handoffId: url.searchParams.get("handoffId") ?? "",
  };
}

async function createHandoff(
  args: {
    readonly callbackScheme?: "ai.vm0.zero.desktop.dev";
  } = {},
) {
  return await accept(
    handoffClient().create({
      body: args.callbackScheme
        ? { callbackScheme: args.callbackScheme }
        : undefined,
      headers: authHeaders(),
    }),
    [200],
  );
}

function expectInvalidOrExpired(response: {
  readonly body: { readonly error: { readonly message: string } };
}): void {
  expect(response.body.error.message).toBe(
    "Desktop sign-in link is invalid or expired.",
  );
}

describe("/api/desktop-auth BDD", () => {
  beforeEach(() => {
    context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
      token: "ticket_desktop_test",
    });
  });

  it("creates a handoff, hides the ticket, consumes it once, and marks it complete", async () => {
    const unauthenticated = await accept(
      handoffClient().create({
        body: {},
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const ownerId = `user_desktop_${randomUUID()}`;
    mockSession(ownerId);

    const handoff = await createHandoff();
    const parts = callbackParts(handoff.body.callbackUrl);

    expect(parts.code).not.toBe("");
    expect(parts.handoffId).toBe(handoff.body.handoffId);
    expect(handoff.body.callbackUrl).not.toContain("ticket");
    expect(handoff.body.callbackUrl).not.toContain("token");

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

    mockSession(ownerId);
    const developmentHandoff = await createHandoff({
      callbackScheme: "ai.vm0.zero.desktop.dev",
    });
    const developmentParts = callbackParts(
      developmentHandoff.body.callbackUrl,
      "ai.vm0.zero.desktop.dev:",
    );

    expect(developmentParts.code).not.toBe("");
    expect(developmentParts.handoffId).toBe(developmentHandoff.body.handoffId);

    const consumed = await accept(
      consumeClient().consume({
        body: { code: parts.code },
      }),
      [200],
    );

    expect(consumed.body.token).toBe("ticket_desktop_test");
    expect(
      context.mocks.clerk.signInTokens.createSignInToken,
    ).toHaveBeenCalledWith({
      userId: ownerId,
      expiresInSeconds: 60,
    });

    const consumedStatus = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(consumedStatus.body.status).toBe("consumed");

    const reused = await accept(
      consumeClient().consume({
        body: { code: parts.code },
      }),
      [400],
    );

    expectInvalidOrExpired(reused);
    expect(
      context.mocks.clerk.signInTokens.createSignInToken,
    ).toHaveBeenCalledTimes(1);

    const completed = await accept(
      handoffClient().complete({
        params: { handoffId: handoff.body.handoffId },
        body: {},
        headers: authHeaders(),
      }),
      [200],
    );

    expect(completed.body.status).toBe("completed");

    const completedStatus = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(completedStatus.body.status).toBe("completed");
  });

  it("keeps unconsumed handoffs incomplete and rejects invalid or expired codes", async () => {
    const createdAt = new Date("2026-05-18T00:00:00.000Z");
    const ownerId = `user_desktop_${randomUUID()}`;
    mockSession(ownerId);
    mockNow(createdAt);

    const handoff = await createHandoff();
    const parts = callbackParts(handoff.body.callbackUrl);

    const unconsumedComplete = await accept(
      handoffClient().complete({
        params: { handoffId: handoff.body.handoffId },
        body: {},
        headers: authHeaders(),
      }),
      [404],
    );

    expect(unconsumedComplete.body.error.code).toBe("NOT_FOUND");

    const stillPending = await accept(
      handoffClient().status({
        params: { handoffId: handoff.body.handoffId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(stillPending.body.status).toBe("pending");

    const invalid = await accept(
      consumeClient().consume({
        body: { code: "invalid desktop code" },
      }),
      [400],
    );

    expectInvalidOrExpired(invalid);

    mockNow(new Date(createdAt.getTime() + 61_000));
    const expired = await accept(
      consumeClient().consume({
        body: { code: parts.code },
      }),
      [400],
    );

    expectInvalidOrExpired(expired);
    expect(
      context.mocks.clerk.signInTokens.createSignInToken,
    ).not.toHaveBeenCalled();
  });
});
