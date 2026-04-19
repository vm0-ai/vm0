import { describe, expect, it } from "vitest";
import { server } from "../../../../mocks/server.ts";
import { mockLocation } from "../../../location.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import {
  createPushStateMock,
  detachedSetupPage,
} from "../../../../__tests__/page-helper.ts";
import { mockUser, clearMockedAuth } from "../../../../__tests__/mock-auth.ts";
import {
  checkSettingsParam$,
  orgManageDialogOpen$,
} from "../org-manage-dialog.ts";
import { orgManageTab$, inviteMember$ } from "../org-manage-tabs-state.ts";
import { searchParams$ } from "../../../route.ts";
import { setMockOrg } from "../../../../mocks/handlers/api-org.ts";
import { zeroOrgInviteContract } from "@vm0/core";
import { mockApi } from "../../../../mocks/msw-contract.ts";

const context = testContext();

function setupAuth(signal: AbortSignal) {
  mockUser(
    { id: "test-user-123", fullName: "Test User" },
    { token: "test-token" },
  );
  signal.addEventListener("abort", () => {
    clearMockedAuth();
  });
}

describe("checkSettingsParam$", () => {
  it("should open dialog on providers tab when ?settings=providers is present", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=providers" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(orgManageTab$)).toBe("providers");
    // The param should be stripped from the URL
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });

  it("should open dialog on billing tab when ?settings=billing is present", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=billing" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(orgManageTab$)).toBe("billing");
  });

  it("should open dialog on usage tab when ?settings=usage is present", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=usage" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(orgManageTab$)).toBe("usage");
  });

  it("should map legacy ?settings=credits to usage tab", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=credits" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(orgManageTab$)).toBe("usage");
  });

  it("should not open dialog when no settings param is present", async () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeFalsy();
  });

  it("should not open dialog for unknown settings value", async () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=unknown" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeFalsy();
    // The param should still be stripped
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });

  it("should redirect non-admin to general tab for admin-only tabs", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    setMockOrg({ role: "member" });
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=billing" }, signal);

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(orgManageTab$)).toBe("general");
  });

  it("should preserve other search params when stripping settings", async () => {
    const { store, signal } = context;
    setupAuth(signal);
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=providers&other=keep" },
      signal,
    );

    await store.set(checkSettingsParam$, signal);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    const params = store.get(searchParams$);
    expect(params.has("settings")).toBeFalsy();
    expect(params.get("other")).toBe("keep");
  });
});

describe("inviteMember$", () => {
  it("should throw ApiError with API message on invite failure", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    server.use(
      mockApi(zeroOrgInviteContract.invite, ({ respond }) => {
        return respond(400, {
          error: {
            message: "Already a member",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }),
    );

    await expect(
      context.store.set(
        inviteMember$,
        "already@example.com",
        "member",
        context.signal,
      ),
    ).rejects.toThrow("Already a member");
  });
});
