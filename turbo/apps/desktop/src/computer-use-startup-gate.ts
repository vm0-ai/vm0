import type { DesktopAuthState } from "./desktop-bridge";
import {
  IDLE_COMPUTER_USE_HOST_STATE,
  hasRequiredComputerUsePermissions,
  type ComputerUseHostRuntimeState,
  type ComputerUsePermissionState,
} from "./computer-use-types";

export const COMPUTER_USE_UNAUTHENTICATED_MESSAGE =
  "Desktop host could not authenticate with the API session. Sign in and retry.";

export const COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE =
  "Zero Desktop is signed in but no workspace is active. Select a workspace and retry.";

export type ComputerUseStartupGate =
  | {
      readonly status: "ready";
    }
  | {
      readonly status: "missing_permissions";
    }
  | {
      readonly status: "blocked";
      readonly host: ComputerUseHostRuntimeState;
    };

export function hasReadyDesktopAuth(
  authState: DesktopAuthState | null,
): boolean {
  return authState?.status === "signed_in" && authState.organization !== null;
}

export function resolveComputerUseStartupGate(args: {
  readonly authState: DesktopAuthState;
  readonly permissions: ComputerUsePermissionState;
}): ComputerUseStartupGate {
  if (!hasRequiredComputerUsePermissions(args.permissions)) {
    return { status: "missing_permissions" };
  }

  if (args.authState.status === "signed_out") {
    return {
      status: "blocked",
      host: {
        ...IDLE_COMPUTER_USE_HOST_STATE,
        status: "unauthenticated",
        lastError: COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
      },
    };
  }

  if (!args.authState.organization) {
    return {
      status: "blocked",
      host: {
        ...IDLE_COMPUTER_USE_HOST_STATE,
        status: "needs_organization",
        lastError: COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
      },
    };
  }

  return { status: "ready" };
}
