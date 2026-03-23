import { describe, expect, it } from "vitest";
import { mockLocation } from "../../../location.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../../__tests__/page-helper.ts";
import {
  checkSettingsParam$,
  orgManageDialogOpen$,
} from "../org-manage-dialog.ts";
import { activeTab$ } from "../org-manage-tabs-state.ts";
import { searchParams$ } from "../../../route.ts";

const context = testContext();

describe("checkSettingsParam$", () => {
  it("should open dialog on providers tab when ?settings=providers is present", () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=providers" }, signal);

    store.set(checkSettingsParam$);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(activeTab$)).toBe("providers");
    // The param should be stripped from the URL
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });

  it("should open dialog on billing tab when ?settings=billing is present", () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=billing" }, signal);

    store.set(checkSettingsParam$);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    expect(store.get(activeTab$)).toBe("billing");
  });

  it("should not open dialog when no settings param is present", () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "" }, signal);

    store.set(checkSettingsParam$);

    expect(store.get(orgManageDialogOpen$)).toBeFalsy();
  });

  it("should not open dialog for unknown settings value", () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation({ pathname: "/", search: "?settings=unknown" }, signal);

    store.set(checkSettingsParam$);

    expect(store.get(orgManageDialogOpen$)).toBeFalsy();
    // The param should still be stripped
    expect(store.get(searchParams$).has("settings")).toBeFalsy();
  });

  it("should preserve other search params when stripping settings", () => {
    const { store, signal } = context;
    createPushStateMock(signal);
    mockLocation(
      { pathname: "/", search: "?settings=providers&other=keep" },
      signal,
    );

    store.set(checkSettingsParam$);

    expect(store.get(orgManageDialogOpen$)).toBeTruthy();
    const params = store.get(searchParams$);
    expect(params.has("settings")).toBeFalsy();
    expect(params.get("other")).toBe("keep");
  });
});
