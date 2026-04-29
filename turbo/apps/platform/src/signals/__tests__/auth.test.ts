import { describe, it, expect, vi, afterEach } from "vitest";
import { testContext } from "./test-helpers";
import { detachedSetupPage, setupPage } from "../../__tests__/page-helper";
import {
  fireClerkListeners,
  mockedClerk,
  mockOrganization,
  mockUser,
} from "../../__tests__/mock-auth";
import {
  setupClerk$,
  user$,
  currentUserInfo$,
  currentOrgInfo$,
  resolveWebOrigin,
} from "../auth";

const context = testContext();

describe("resolveWebOrigin", () => {
  it("should replace platform subdomain with www", () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/agents"));
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
  });

  it("should replace app subdomain with www", () => {
    vi.stubGlobal("location", new URL("https://app.vm0.ai/connectors"));
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
  });

  it("should handle hyphenated subdomains like staging-platform", () => {
    vi.stubGlobal(
      "location",
      new URL("https://staging-platform.vm0.ai/agents"),
    );
    expect(resolveWebOrigin()).toBe("https://staging-www.vm0.ai");
  });

  it("should return origin unchanged when no platform/app subdomain", () => {
    vi.stubGlobal("location", new URL("https://www.vm0.ai/"));
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
  });

  it("should return empty string when origin is missing", () => {
    vi.stubGlobal("location", { origin: "" });
    expect(resolveWebOrigin()).toBe("");
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

describe("currentUserInfo$ re-emits on Clerk listener events", () => {
  it("picks up profile changes after fireClerkListeners", async () => {
    const { store, signal } = context;

    detachedSetupPage({ context, path: "/", withoutRender: true });
    await store.set(setupClerk$, signal);

    const before = await store.get(currentUserInfo$);
    expect(before?.fullName).toBe("Test User");

    mockUser(
      {
        id: "test-user-123",
        fullName: "Renamed User",
        firstName: "Renamed",
        email: "renamed@example.com",
        imageUrl: "https://example.com/new-avatar.png",
      },
      { token: "test-token" },
    );
    fireClerkListeners();

    const after = await store.get(currentUserInfo$);
    expect(after).toMatchObject({
      id: "test-user-123",
      fullName: "Renamed User",
      firstName: "Renamed",
      imageUrl: "https://example.com/new-avatar.png",
      primaryEmailAddress: { emailAddress: "renamed@example.com" },
    });
  });
});

describe("currentOrgInfo$ re-emits on Clerk listener events", () => {
  it("picks up in-place mutations to the active org's imageUrl after fireClerkListeners", async () => {
    const { store, signal } = context;

    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: {
          id: "org_A",
          name: "Org A",
          slug: "org-a",
          imageUrl: "https://example.com/old-logo.png",
          hasImage: true,
        },
        memberships: [{ id: "org_A" }],
      },
      withoutRender: true,
    });
    await store.set(setupClerk$, signal);

    const before = await store.get(currentOrgInfo$);
    expect(before?.imageUrl).toBe("https://example.com/old-logo.png");

    // Simulate the Clerk SDK mutating imageUrl in place after a
    // successful `clerk.organization.reload()` — the production bug
    // this PR fixes is that subscribers never re-rendered because
    // ccstate cannot see in-place mutations. Firing the listener is
    // the production trigger that bumps clerkVersion$ and forces the
    // computed to re-emit.
    mockOrganization({
      activeOrg: {
        id: "org_A",
        name: "Org A",
        slug: "org-a",
        imageUrl: "https://example.com/new-logo.png",
        hasImage: true,
      },
      memberships: [{ id: "org_A" }],
    });
    fireClerkListeners();

    const after = await store.get(currentOrgInfo$);
    expect(after?.imageUrl).toBe("https://example.com/new-logo.png");
  });

  it("returns null when there is no active organization", async () => {
    const { store, signal } = context;

    detachedSetupPage({
      context,
      path: "/",
      org: { activeOrg: null, memberships: [] },
      withoutRender: true,
    });
    await store.set(setupClerk$, signal);

    const info = await store.get(currentOrgInfo$);
    expect(info).toBeNull();
  });
});

describe("watchOrgSwitch$ JWT rotation on org change", () => {
  afterEach(() => {
    // Reset href between tests — the listener assigns it to "/"
    if (window.location.href !== "http://localhost/") {
      window.location.href = "http://localhost/";
    }
  });

  it("rotates the Clerk JWT with skipCache:true before navigating on org switch", async () => {
    // Force `window.location` away from "/" so the production listener
    // assignment `location.href = "/"` produces an observable change.
    // happy-dom's default pathname is already "/", and the mocked
    // `pushState` does not touch `window.location` — we must set the
    // href directly.
    window.location.href = "http://localhost/agents";
    expect(window.location.pathname).toBe("/agents");

    // Bootstrap with an initial active org so watchOrgSwitch$ captures
    // it as prevOrgId. Use the awaited `setupPage` so the Clerk
    // listener is registered before we simulate the org switch below.
    await setupPage({
      context,
      path: "/agents",
      org: {
        activeOrg: { id: "org_A", name: "Org A" },
        memberships: [{ id: "org_A" }, { id: "org_B" }],
      },
      withoutRender: true,
    });

    // Simulate an org switch: flip the mocked active org, then fire
    // the Clerk listeners (the production trigger path is
    // `clerk.setActive({ organization })` which fires listeners under
    // the hood — the mock exposes `fireClerkListeners` to simulate it).
    mockOrganization({
      activeOrg: { id: "org_B", name: "Org B" },
      memberships: [{ id: "org_A" }, { id: "org_B" }],
    });
    fireClerkListeners();

    // The listener invokes getToken({ skipCache: true }) and then
    // assigns location.href. Both should land once the microtask
    // queue drains — the pathname change from "/agents" to "/" is the
    // observable marker that the reload ran.
    await vi.waitFor(() => {
      expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
        skipCache: true,
      });
    });
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("still reloads when getToken rejects (refresh failure is swallowed)", async () => {
    // Force `window.location` away from "/" so the reload is
    // observable (see explanation in the happy-path test above).
    window.location.href = "http://localhost/agents";
    expect(window.location.pathname).toBe("/agents");

    await setupPage({
      context,
      path: "/agents",
      org: {
        activeOrg: { id: "org_A", name: "Org A" },
        memberships: [{ id: "org_A" }, { id: "org_B" }],
      },
      withoutRender: true,
    });

    // Arm the rejection AFTER bootstrap so it only fires on the
    // listener's skipCache:true call (not on unrelated pre-bootstrap
    // fetches that also call getToken()).
    mockedClerk.sessionGetToken.mockRejectedValueOnce(
      new Error("token endpoint down"),
    );

    mockOrganization({
      activeOrg: { id: "org_B", name: "Org B" },
      memberships: [{ id: "org_A" }, { id: "org_B" }],
    });
    fireClerkListeners();

    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });
});
