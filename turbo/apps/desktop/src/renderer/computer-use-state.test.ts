import { describe, expect, it } from "vitest";
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
  it("allows startup only when platform and permissions are ready", () => {
    expect(shouldAutoStartComputerUse(computerUseState())).toBe(true);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          permissions: { accessibility: true, screenRecording: false },
        }),
      ),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(computerUseState({ supported: false })),
    ).toBe(false);
  });

  it("does not restart active or terminal runtime states", () => {
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "online" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "connecting" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "unauthenticated" },
        }),
      ),
    ).toBe(true);
    expect(
      shouldAutoStartComputerUse(
        computerUseState({
          host: { ...computerUseState().host, status: "needs_organization" },
        }),
      ),
    ).toBe(false);
  });
});
