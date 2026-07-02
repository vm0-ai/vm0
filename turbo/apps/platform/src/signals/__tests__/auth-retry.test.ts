import { createStore } from "ccstate";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearMockNow, mockNow } from "../../lib/time.ts";
import {
  handleUnauthorizedRedirect,
  suppressUnauthorizedRedirectForAuthTransition$,
  type ClerkLike,
  unauthorizedRedirectSuppressionUntil$,
} from "../auth-retry.ts";

function createClerk(): {
  clerk: ClerkLike;
  redirectToSignIn: ClerkLike["redirectToSignIn"];
} {
  const redirectToSignIn: ClerkLike["redirectToSignIn"] = vi.fn();
  return {
    clerk: {
      session: null,
      redirectToSignIn,
    },
    redirectToSignIn,
  };
}

describe("auth retry redirect handling", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("does not redirect to sign-in during an auth transition", () => {
    mockNow(new Date("2026-01-01T00:00:00.000Z"));
    const store = createStore();
    const { clerk, redirectToSignIn } = createClerk();

    store.set(suppressUnauthorizedRedirectForAuthTransition$);
    handleUnauthorizedRedirect(
      clerk,
      store.get(unauthorizedRedirectSuppressionUntil$),
    );

    expect(redirectToSignIn).not.toHaveBeenCalled();
  });

  it("redirects to sign-in after the auth transition window expires", () => {
    mockNow(new Date("2026-01-01T00:00:00.000Z"));
    const store = createStore();
    const { clerk, redirectToSignIn } = createClerk();

    store.set(suppressUnauthorizedRedirectForAuthTransition$);
    mockNow(new Date("2026-01-01T00:00:30.001Z"));
    handleUnauthorizedRedirect(
      clerk,
      store.get(unauthorizedRedirectSuppressionUntil$),
    );

    expect(redirectToSignIn).toHaveBeenCalledWith();
  });
});
