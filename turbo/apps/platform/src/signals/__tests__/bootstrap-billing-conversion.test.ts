import { describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";

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

function mockSignedInUser(): void {
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
}

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
    mockSignedInUser();

    pushState({}, "", "/?billing=pro&billing_session_id=cs_test_pro");
    await context.store.set(bootstrap$, () => {}, context.signal);

    expect(gtag).not.toHaveBeenCalled();
    expect(new URLSearchParams(search()).has("billing")).toBeFalsy();
    expect(new URLSearchParams(search()).has("billing_session_id")).toBeFalsy();
  });

  it("shows a success toast for concurrency checkout success redirects", async () => {
    const successToast = vi.spyOn(toast, "success");
    context.signal.addEventListener("abort", () => {
      successToast.mockRestore();
    });
    mockSignedInUser();

    pushState({}, "", "/?concurrency=purchased");
    await context.store.set(bootstrap$, () => {}, context.signal);
    window.dispatchEvent(new Event("load"));

    await vi.waitFor(() => {
      expect(successToast).toHaveBeenCalledWith(
        "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
      );
    });
    expect(new URLSearchParams(search()).has("concurrency")).toBeFalsy();
  });
});
