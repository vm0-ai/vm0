import { afterEach, describe, expect, it } from "vitest";
import { mockLocation } from "../../../location.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../../__tests__/page-helper.ts";
import { mockUser, clearMockedAuth } from "../../../../__tests__/mock-auth.ts";
import {
  checkUnifiedSettingsParam$,
  setSettingsActiveSection$,
  setSettingsDialogOpen$,
  settingsActiveSection$,
  settingsDialogOpen$,
} from "../settings-dialog.ts";
import {
  billingScrollTarget$,
  billingSubPage$,
} from "../org-manage-tabs-state.ts";
import { searchParams$ } from "../../../route.ts";
import {
  resetMockOrg,
  setMockOrg,
} from "../../../../mocks/handlers/api-org.ts";

const context = testContext();

afterEach(() => {
  resetMockOrg();
});

function setupAuth(signal: AbortSignal) {
  mockUser(
    { id: "test-user-123", fullName: "Test User" },
    { token: "test-token" },
  );
  signal.addEventListener("abort", () => {
    clearMockedAuth();
  });
}

describe("checkUnifiedSettingsParam$", () => {
  it("opens dialog on billing section for admin when ?settings=billing", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=billing" }, signal);

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeTruthy();
    expect(store.get(settingsActiveSection$)).toBe("billing");
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });

  it("opens billing on Compare plans when ?settings=billing&billingView=plans", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=billing&billingView=plans" },
      signal,
    );

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeTruthy();
    expect(store.get(settingsActiveSection$)).toBe("billing");
    expect(store.get(billingSubPage$)).toBeTruthy();
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
    expect(store.get(searchParams$).has("billingView")).toBeFalsy();
  });

  it("opens billing on Buy credits when ?settings=billing&billingView=credits", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=billing&billingView=credits" },
      signal,
    );

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeTruthy();
    expect(store.get(settingsActiveSection$)).toBe("billing");
    expect(store.get(billingSubPage$)).toBeFalsy();
    expect(store.get(billingScrollTarget$)).toBe("buy-credits");
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
    expect(store.get(searchParams$).has("billingView")).toBeFalsy();
  });

  it("keeps non-admins on the home page when opening Compare plans link", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    setMockOrg({ role: "member" });
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=billing&billingView=plans" },
      signal,
    );

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeFalsy();
    expect(store.get(billingSubPage$)).toBeFalsy();
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
    expect(store.get(searchParams$).has("billingView")).toBeFalsy();
  });

  it("keeps non-admins on the home page when opening Buy credits link", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    setMockOrg({ role: "member" });
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=billing&billingView=credits" },
      signal,
    );

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeFalsy();
    expect(store.get(billingSubPage$)).toBeFalsy();
    expect(store.get(billingScrollTarget$)).toBeNull();
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
    expect(store.get(searchParams$).has("billingView")).toBeFalsy();
  });

  it("falls back to preference for non-admin on admin-only section", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    setMockOrg({ role: "member" });
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=billing" }, signal);

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeTruthy();
    expect(store.get(settingsActiveSection$)).toBe("preference");
  });

  it("does not open dialog for unknown settings value", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=unknown" }, signal);

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeFalsy();
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });

  it("does nothing when no settings param present", async () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "" }, signal);

    await store.set(checkUnifiedSettingsParam$, signal);

    expect(store.get(settingsDialogOpen$)).toBeFalsy();
  });

  it("preserves other search params when stripping settings", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=preference&other=keep" },
      signal,
    );

    await store.set(checkUnifiedSettingsParam$, signal);

    const params = store.get(searchParams$);
    expect(params.has("settings")).toBeFalsy();
    expect(params.get("other")).toBe("keep");
  });
});

describe("setSettingsActiveSection$", () => {
  it("updates active section and syncs URL", () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "" }, signal);

    store.set(setSettingsActiveSection$, "model");

    expect(store.get(settingsActiveSection$)).toBe("model");
    expect(store.get(searchParams$).get("settings")).toBe("model");
  });

  it("does not redundantly rewrite URL when section already matches", () => {
    const { store, signal } = context;
    const pushSpy = createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=debug" }, signal);

    store.set(setSettingsActiveSection$, "debug");

    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe("setSettingsDialogOpen$", () => {
  it("removes ?settings from URL when closing the dialog", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=preference" }, signal);

    await store.set(setSettingsDialogOpen$, true, signal);
    expect(store.get(settingsDialogOpen$)).toBeTruthy();

    await store.set(setSettingsDialogOpen$, false, signal);

    expect(store.get(settingsDialogOpen$)).toBeFalsy();
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });
});
