import { describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import { bootstrap$ } from "../bootstrap.ts";
import { pushState, search } from "../location.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

type WindowWithGtag = Window & {
  gtag?: (...args: unknown[]) => void;
};

describe("bootstrap billing redirect conversion handling", () => {
  it("does not fire Google Ads conversion on Pro checkout success redirects", async () => {
    const windowWithGtag = window as WindowWithGtag;
    const originalGtag = windowWithGtag.gtag;
    const gtag = vi.fn();

    Object.defineProperty(windowWithGtag, "gtag", {
      configurable: true,
      value: gtag,
      writable: true,
    });
    context.signal.addEventListener("abort", () => {
      if (originalGtag !== undefined) {
        Object.defineProperty(windowWithGtag, "gtag", {
          configurable: true,
          value: originalGtag,
          writable: true,
        });
        return;
      }
      Reflect.deleteProperty(windowWithGtag, "gtag");
    });
    mockUser(
      {
        id: "test-user-123",
        fullName: "Test User",
      },
      {
        token: "test-token",
      },
    );
    mockOrganization({
      activeOrg: { id: "org_default", name: "Default Org" },
      memberships: [{ id: "org_default" }],
    });
    context.signal.addEventListener("abort", () => {
      clearMockedAuth();
    });

    pushState({}, "", "/?billing=pro&billing_session_id=cs_test_pro");
    await context.store.set(bootstrap$, () => {}, context.signal);

    expect(gtag).not.toHaveBeenCalled();
    expect(new URLSearchParams(search()).has("billing")).toBeFalsy();
    expect(new URLSearchParams(search()).has("billing_session_id")).toBeFalsy();
  });
});
