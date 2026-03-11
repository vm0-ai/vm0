import { describe, it, expect } from "vitest";
import { testContext } from "./test-helpers";
import { setupPage } from "../../__tests__/page-helper";
import { fireClerkListeners, mockUser } from "../../__tests__/mock-auth";
import { setupClerk$, user$ } from "../auth";

const context = testContext();

describe("setupClerk$ auth reload filtering", () => {
  it("should not trigger user$ recomputation on token refresh (same user)", async () => {
    const { store, signal } = context;

    await setupPage({ context, path: "/", withoutRender: true });
    await store.set(setupClerk$, signal);

    const userBefore = await store.get(user$);
    expect(userBefore?.id).toBe("test-user-123");

    // Simulate a Clerk token refresh — user stays the same
    fireClerkListeners();

    const userAfter = await store.get(user$);
    expect(userAfter?.id).toBe("test-user-123");
  });

  it("should update user$ when user signs out", async () => {
    const { store, signal } = context;

    await setupPage({ context, path: "/", withoutRender: true });
    await store.set(setupClerk$, signal);

    const userBefore = await store.get(user$);
    expect(userBefore?.id).toBe("test-user-123");

    // Simulate sign-out: clear the mocked user, then fire listeners
    mockUser(null, null);
    fireClerkListeners();

    const userAfter = await store.get(user$);
    expect(userAfter).toBeUndefined();
  });
});
