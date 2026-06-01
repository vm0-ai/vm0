import { describe, expect, it } from "vitest";
import type { DesktopAuthState } from "../desktop-bridge";
import {
  hasRequiredComputerUsePermissions,
  type DesktopComputerUseState,
} from "../computer-use-types";
import { shouldAutoStartComputerUse } from "./computer-use-state";

function computerUseState(
  overrides: Partial<DesktopComputerUseState> = {},
): DesktopComputerUseState {
  return {
    featureSwitchKey: "computerUse",
    platform: "darwin",
    supported: true,
    permissions: { accessibility: true, screenRecording: true },
    host: {
      status: "idle",
      hostId: null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recentAuditEvents: [],
      localCommandLog: [],
    },
    ...overrides,
  };
}

const signedOutAuth: DesktopAuthState = {
  status: "signed_out",
  user: null,
  organization: null,
};

const signedInAuth: DesktopAuthState = {
  status: "signed_in",
  user: { userId: "user-1", email: "user@example.com" },
  organization: { id: "org-1", name: "Org One", slug: "org-one" },
};

describe("hasRequiredComputerUsePermissions", () => {
  it("requires accessibility and screen recording before startup", () => {
    expect(
      hasRequiredComputerUsePermissions({
        accessibility: true,
        screenRecording: true,
      }),
    ).toBe(true);
    expect(
      hasRequiredComputerUsePermissions({
        accessibility: true,
        screenRecording: false,
      }),
    ).toBe(false);
  });
});

describe("shouldAutoStartComputerUse", () => {
  it("allows startup only when auth, platform, and permissions are ready", () => {
    expect(shouldAutoStartComputerUse(computerUseState(), signedInAuth)).toBe(
      true,
    );
    expect(shouldAutoStartComputerUse(computerUseState(), null)).toBe(false);
    expect(shouldAutoStartComputerUse(computerUseState(), signedOutAuth)).toBe(
      false,
    );
    expect(
      shouldAutoStartComputerUse(computerUseState(), {
        ...signedInAuth,
        organization: null,
      }),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          permissions: { accessibility: true, screenRecording: false },
        }),
        signedInAuth,
      ),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({ supported: false }),
        signedInAuth,
      ),
    ).toBe(false);
  });

  it("does not restart active or terminal runtime states", () => {
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "online" },
        }),
        signedInAuth,
      ),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "connecting" },
        }),
        signedInAuth,
      ),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "unauthenticated" },
        }),
        signedInAuth,
      ),
    ).toBe(true);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "needs_organization" },
        }),
        signedInAuth,
      ),
    ).toBe(false);
  });
});
