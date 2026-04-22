import { describe, it, expect, vi, afterEach } from "vitest";
import { testContext } from "./test-helpers";
import { detachedSetupPage } from "../../__tests__/page-helper";
import {
  clearMockedAuth,
  clerkListenerCount,
  fireClerkListeners,
  mockOrganization,
  mockedClerk,
  mockUser,
} from "../../__tests__/mock-auth";
import { setupClerk$, user$, resolveWebOrigin, watchOrgSwitch$ } from "../auth";
import { detach, Reason } from "../utils";

const context = testContext();

describe("resolveWebOrigin", () => {
  it("should replace platform subdomain with www", () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/agents"));
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
    vi.unstubAllGlobals();
  });

  it("should replace app subdomain with www", () => {
    vi.stubGlobal("location", new URL("https://app.vm0.ai/connectors"));
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
    vi.unstubAllGlobals();
  });

  it("should handle hyphenated subdomains like staging-platform", () => {
    vi.stubGlobal(
      "location",
      new URL("https://staging-platform.vm0.ai/agents"),
    );
    expect(resolveWebOrigin()).toBe("https://staging-www.vm0.ai");
    vi.unstubAllGlobals();
  });

  it("should return origin unchanged when no platform/app subdomain", () => {
    vi.stubGlobal("location", new URL("https://www.vm0.ai/"));
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
    vi.unstubAllGlobals();
  });

  it("should return empty string when origin is missing", () => {
    vi.stubGlobal("location", { origin: "" });
    expect(resolveWebOrigin()).toBe("");
    vi.unstubAllGlobals();
  });
});

describe("setupClerk$ auth reload filtering", () => {
  it("should not trigger user$ recomputation on token refresh (same user)", async () => {
    const { store, signal } = context;

    detachedSetupPage({ context, path: "/", withoutRender: true });
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

    detachedSetupPage({ context, path: "/", withoutRender: true });
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

describe("watchOrgSwitch$", () => {
  afterEach(() => {
    if (window.location.pathname !== "/") {
      window.location.href = "http://localhost/";
    }
    // These tests don't go through detachedSetupPage, which would hook
    // this up via signal abort — do it manually so mock-call history and
    // stub implementations don't leak across cases.
    clearMockedAuth();
  });

  it("rotates the session JWT before reloading when the active org changes", async () => {
    const { store, signal } = context;

    mockUser(
      { id: "test-user", fullName: "Test User" },
      { token: "test-token" },
    );
    mockOrganization({
      activeOrg: { id: "org_a", name: "Org A" },
      memberships: [{ id: "org_a" }, { id: "org_b" }],
    });
    const listenersBefore = clerkListenerCount();
    // watchOrgSwitch$ is a daemon that never resolves on its own.
    detach(store.set(watchOrgSwitch$, signal), Reason.Daemon);

    // Wait until the daemon has registered its listener — only then will
    // fireClerkListeners reach it.
    await vi.waitFor(() => {
      expect(clerkListenerCount()).toBeGreaterThan(listenersBefore);
    });

    // Simulate an active-org change — either this tab's own setActive, or
    // Clerk's cross-tab sync from a sibling tab. The watcher treats them
    // the same.
    mockOrganization({
      activeOrg: { id: "org_b", name: "Org B" },
      memberships: [{ id: "org_a" }, { id: "org_b" }],
    });
    fireClerkListeners();

    // The shared .vm0.ai session cookie is rotated by Clerk only when a
    // new JWT is minted — skipCache ensures the next request to www.vm0.ai
    // sees the new orgId claim instead of a stale cached one.
    await vi.waitFor(() => {
      expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
        skipCache: true,
      });
    });
  });

  it("ignores listener fires that do not change the active org", async () => {
    const { store, signal } = context;

    mockUser(
      { id: "test-user", fullName: "Test User" },
      { token: "test-token" },
    );
    mockOrganization({
      activeOrg: { id: "org_a", name: "Org A" },
      memberships: [{ id: "org_a" }],
    });
    const listenersBefore = clerkListenerCount();
    detach(store.set(watchOrgSwitch$, signal), Reason.Daemon);

    await vi.waitFor(() => {
      expect(clerkListenerCount()).toBeGreaterThan(listenersBefore);
    });

    // Token refresh without an org change fires the listener repeatedly —
    // the watcher must not trigger a JWT refresh or navigation.
    fireClerkListeners();
    fireClerkListeners();
    fireClerkListeners();

    expect(mockedClerk.sessionGetToken).not.toHaveBeenCalledWith({
      skipCache: true,
    });
  });
});
