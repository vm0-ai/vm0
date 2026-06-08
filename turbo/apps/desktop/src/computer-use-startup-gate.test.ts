import { describe, expect, it } from "vitest";
import type { DesktopAuthState } from "./desktop-bridge";
import {
  COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
  COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
  hasReadyDesktopAuth,
  resolveComputerUseStartupGate,
} from "./computer-use-startup-gate";
import type { ComputerUsePermissionState } from "./computer-use-types";

const grantedPermissions: ComputerUsePermissionState = {
  accessibility: true,
  screenRecording: true,
};

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

describe("hasReadyDesktopAuth", () => {
  it("requires a signed-in user with an active organization", () => {
    expect(hasReadyDesktopAuth(null)).toBe(false);
    expect(hasReadyDesktopAuth(signedOutAuth)).toBe(false);
    expect(hasReadyDesktopAuth({ ...signedInAuth, organization: null })).toBe(
      false,
    );
    expect(hasReadyDesktopAuth(signedInAuth)).toBe(true);
  });
});

describe("resolveComputerUseStartupGate", () => {
  it("blocks startup before host registration when signed out", () => {
    const gate = resolveComputerUseStartupGate({
      authState: signedOutAuth,
      permissions: grantedPermissions,
    });

    expect(gate).toEqual({
      status: "blocked",
      host: {
        status: "unauthenticated",
        hostId: null,
        lastHeartbeatAt: null,
        lastCommandAt: null,
        lastError: COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
        recentAuditEvents: [],
        localCommandLog: [],
      },
    });
  });

  it("blocks startup before host registration when no organization is active", () => {
    const gate = resolveComputerUseStartupGate({
      authState: { ...signedInAuth, organization: null },
      permissions: grantedPermissions,
    });

    expect(gate).toMatchObject({
      status: "blocked",
      host: {
        status: "needs_organization",
        lastError: COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
      },
    });
  });

  it("blocks startup when required local permissions are missing", () => {
    expect(
      resolveComputerUseStartupGate({
        authState: signedInAuth,
        permissions: { accessibility: true, screenRecording: false },
      }),
    ).toEqual({ status: "missing_permissions" });
  });

  it("allows startup only when auth and local permissions are ready", () => {
    expect(
      resolveComputerUseStartupGate({
        authState: signedInAuth,
        permissions: grantedPermissions,
      }),
    ).toEqual({ status: "ready" });
  });
});
