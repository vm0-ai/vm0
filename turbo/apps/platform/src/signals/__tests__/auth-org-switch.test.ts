import { describe, expect, it } from "vitest";

import {
  emitMockedClerkEvent,
  mockedClerk,
  mockOrganization,
} from "../../__tests__/mock-auth.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const activeOrgIdStorage = sessionStorageSignals("clerk-active-org-id");

describe("organization auth lifecycle", () => {
  it("keeps the active organization through a transient Clerk refresh", async () => {
    context.mocks.browser.url("http://localhost/error");

    await setupPage({
      context,
      path: "/error",
      org: {
        activeOrg: { id: "org_A", name: "Org A" },
        memberships: [{ id: "org_A" }],
      },
      withoutRender: true,
    });
    mockedClerk.sessionGetToken.mockClear();

    mockOrganization({
      activeOrg: null,
      memberships: [{ id: "org_A" }],
    });
    emitMockedClerkEvent();

    expect(context.store.get(activeOrgIdStorage.get$)).toBe("org_A");

    mockOrganization({
      activeOrg: { id: "org_A", name: "Org A" },
      memberships: [{ id: "org_A" }],
    });
    emitMockedClerkEvent();

    expect(mockedClerk.sessionGetToken).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/error");
  });
});
