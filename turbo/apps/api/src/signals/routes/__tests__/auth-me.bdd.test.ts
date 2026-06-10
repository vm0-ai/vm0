import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for `/api/auth/me`. The caller's email is owned by
// Clerk, so the profile lookup is the one external precondition we mock; the
// 15-minute user-cache freshness is exercised by issuing real requests across
// `mockNow`, not by seeding the cache. The endpoint accepts Clerk sessions as
// well as sandbox/zero scoped tokens. See `api.bdd.md` (CHAIN-AUTH-ME).
const context = testContext();

const NOW_MS = Date.parse("2026-05-12T04:00:00.000Z");

describe("auth me (API-first BDD)", () => {
  it("chain-auth-me: returns the email and serves a fresh cache without re-fetching Clerk", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();
    api.mockClerkUserEmail(admin.userId, "test@example.com", {
      firstName: "Test",
      lastName: "User",
    });

    // When the caller resolves their identity. Then it carries the Clerk email.
    const first = await accept(api.authMe.me({ headers: SESSION_AUTH }), [200]);
    expect(first.body).toStrictEqual({
      userId: admin.userId,
      email: "test@example.com",
    });

    // When they resolve it again within the cache window. Then the cached email
    // is served without a second Clerk profile fetch.
    const second = await accept(
      api.authMe.me({ headers: SESSION_AUTH }),
      [200],
    );
    expect(second.body).toStrictEqual({
      userId: admin.userId,
      email: "test@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(1);
  });

  it("re-fetches Clerk once the cached email is stale", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();
    mockNow(NOW_MS);
    api.mockClerkUserEmail(admin.userId, "stale@example.com");

    // Given a cache populated at the current time.
    await accept(api.authMe.me({ headers: SESSION_AUTH }), [200]);

    // When the cache ages past its 15-minute TTL and the profile changes.
    mockNow(NOW_MS + 16 * 60 * 1000);
    api.mockClerkUserEmail(admin.userId, "fresh@example.com");
    const refreshed = await accept(
      api.authMe.me({ headers: SESSION_AUTH }),
      [200],
    );

    // Then the response reflects the refreshed Clerk email.
    expect(refreshed.body).toStrictEqual({
      userId: admin.userId,
      email: "fresh@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
  });

  it("accepts sandbox and zero scoped tokens", async () => {
    const api = createBddApi(context);

    // A sandbox-scoped token (no required capability) resolves the email.
    const sandboxUser = `user_${randomUUID()}`;
    api.mockClerkUserEmail(sandboxUser, "sandbox@example.com");
    const sandbox = await accept(
      api.authMe.me({ headers: api.sandboxAuth(sandboxUser) }),
      [200],
    );
    expect(sandbox.body).toStrictEqual({
      userId: sandboxUser,
      email: "sandbox@example.com",
    });

    // A zero token carrying file:write resolves too.
    const fileUser = `user_${randomUUID()}`;
    api.mockOrgMemberships([]);
    api.mockClerkUserEmail(fileUser, "file@example.com");
    const fileWrite = await accept(
      api.authMe.me({ headers: api.zeroAuthFor(fileUser, ["file:write"]) }),
      [200],
    );
    expect(fileWrite.body).toStrictEqual({
      userId: fileUser,
      email: "file@example.com",
    });

    // A zero token with no capabilities resolves too.
    const bareUser = `user_${randomUUID()}`;
    api.mockOrgMemberships([]);
    api.mockClerkUserEmail(bareUser, "empty@example.com");
    const noCaps = await accept(
      api.authMe.me({ headers: api.zeroAuthFor(bareUser, []) }),
      [200],
    );
    expect(noCaps.body).toStrictEqual({
      userId: bareUser,
      email: "empty@example.com",
    });
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const api = createBddApi(context);

    const response = await accept(api.authMe.me({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
