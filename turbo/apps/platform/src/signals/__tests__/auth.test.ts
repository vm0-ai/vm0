import { describe, it, expect, vi } from "vitest";
import { testContext } from "./test-helpers";
import { detachedSetupPage } from "../../__tests__/page-helper";
import { fireClerkListeners, mockUser } from "../../__tests__/mock-auth";
import { setupClerk$, user$, resolveWebOrigin } from "../auth";

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
