// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_USE_FEATURE_SWITCH_KEY,
  type ComputerUseHostRuntimeStatus,
  type ComputerUsePermissionState,
  type DesktopComputerUseState,
  type DesktopKeepAwakeState,
} from "../computer-use-types";
import type {
  DesktopAuthApi,
  DesktopAuthState,
  DesktopComputerUseApi,
} from "../desktop-bridge";
import { App } from "./App";

const signedInAuthState: DesktopAuthState = {
  status: "signed_in",
  user: {
    userId: "user_test",
    email: "desktop@example.com",
  },
  organization: {
    id: "org_test",
    name: "Desktop Team",
    slug: "desktop-team",
  },
};

const signedOutAuthState: DesktopAuthState = {
  status: "signed_out",
  user: null,
  organization: null,
};

function createComputerUseState({
  keepAwake = { active: false, enabled: false },
  permissions = { accessibility: true, screenRecording: true },
  status = "offline",
}: {
  readonly keepAwake?: DesktopKeepAwakeState;
  readonly permissions?: ComputerUsePermissionState;
  readonly status?: ComputerUseHostRuntimeStatus;
} = {}): DesktopComputerUseState {
  return {
    featureSwitchKey: COMPUTER_USE_FEATURE_SWITCH_KEY,
    platform: "darwin",
    supported: true,
    permissions,
    host: {
      status,
      hostId: status === "online" ? "host_test" : null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
      recentAuditEvents: [],
      localCommandLog: [],
    },
    keepAwake,
  };
}

function createComputerUseBridge(initialState: DesktopComputerUseState): {
  readonly api: DesktopComputerUseApi;
  readonly emitState: (nextState: DesktopComputerUseState) => void;
  readonly getState: ReturnType<
    typeof vi.fn<DesktopComputerUseApi["getState"]>
  >;
  readonly start: ReturnType<typeof vi.fn<DesktopComputerUseApi["start"]>>;
  readonly subscribe: ReturnType<
    typeof vi.fn<DesktopComputerUseApi["subscribe"]>
  >;
} {
  let currentState = initialState;
  const subscribers = new Set<() => void>();
  const getState = vi.fn<DesktopComputerUseApi["getState"]>(async () => {
    return currentState;
  });
  const refreshPermissions = vi.fn<DesktopComputerUseApi["refreshPermissions"]>(
    async () => {
      return currentState;
    },
  );
  const start = vi.fn<DesktopComputerUseApi["start"]>(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: currentState.permissions,
      status: "online",
    });
    return currentState;
  });
  const stop = vi.fn<DesktopComputerUseApi["stop"]>(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: currentState.permissions,
    });
    return currentState;
  });
  const requestAccessibilityPermission = vi.fn<
    DesktopComputerUseApi["requestAccessibilityPermission"]
  >(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: {
        ...currentState.permissions,
        accessibility: true,
      },
      status: currentState.host.status,
    });
    return currentState;
  });
  const requestScreenRecordingPermission = vi.fn<
    DesktopComputerUseApi["requestScreenRecordingPermission"]
  >(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: {
        ...currentState.permissions,
        screenRecording: true,
      },
      status: currentState.host.status,
    });
    return currentState;
  });
  const setKeepAwakeEnabled = vi.fn<
    DesktopComputerUseApi["setKeepAwakeEnabled"]
  >(async (enabled) => {
    currentState = createComputerUseState({
      keepAwake: {
        active: enabled,
        enabled,
      },
      permissions: currentState.permissions,
      status: currentState.host.status,
    });
    return currentState;
  });
  const subscribe = vi.fn<DesktopComputerUseApi["subscribe"]>((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  const api: DesktopComputerUseApi = {
    getState,
    refreshPermissions,
    start,
    stop,
    requestAccessibilityPermission,
    requestScreenRecordingPermission,
    setKeepAwakeEnabled,
    openAccessibilitySettings: vi.fn<
      DesktopComputerUseApi["openAccessibilitySettings"]
    >(async () => {}),
    openScreenRecordingSettings: vi.fn<
      DesktopComputerUseApi["openScreenRecordingSettings"]
    >(async () => {}),
    subscribe,
  };

  return {
    api,
    emitState: (nextState) => {
      currentState = nextState;
      for (const subscriber of subscribers) {
        subscriber();
      }
    },
    getState,
    start,
    subscribe,
  };
}

function createAuthBridge(initialState: DesktopAuthState): {
  readonly api: DesktopAuthApi;
  readonly getState: ReturnType<typeof vi.fn<DesktopAuthApi["getState"]>>;
  readonly openSignIn: ReturnType<typeof vi.fn<DesktopAuthApi["openSignIn"]>>;
} {
  let currentState = initialState;
  const subscribers = new Set<() => void>();
  const getState = vi.fn<DesktopAuthApi["getState"]>(async () => {
    return currentState;
  });
  const openSignIn = vi.fn<DesktopAuthApi["openSignIn"]>(async () => {});
  const openOrgSelection = vi.fn<DesktopAuthApi["openOrgSelection"]>(
    async () => {},
  );
  const signOut = vi.fn<DesktopAuthApi["signOut"]>(async () => {
    currentState = signedOutAuthState;
    for (const subscriber of subscribers) {
      subscriber();
    }
  });
  const subscribe = vi.fn<DesktopAuthApi["subscribe"]>((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  const api: DesktopAuthApi = {
    getState,
    openSignIn,
    openOrgSelection,
    signOut,
    completeSignIn: vi.fn<DesktopAuthApi["completeSignIn"]>(async () => {}),
    subscribe,
  };

  return {
    api,
    getState,
    openSignIn,
  };
}

function installDesktopBridges({
  authState = signedInAuthState,
  computerUseState = createComputerUseState(),
}: {
  readonly authState?: DesktopAuthState;
  readonly computerUseState?: DesktopComputerUseState;
} = {}): {
  readonly auth: ReturnType<typeof createAuthBridge>;
  readonly computerUse: ReturnType<typeof createComputerUseBridge>;
} {
  const auth = createAuthBridge(authState);
  const computerUse = createComputerUseBridge(computerUseState);
  window.vm0DesktopAuth = auth.api;
  window.vm0DesktopComputerUse = computerUse.api;
  return {
    auth,
    computerUse,
  };
}

function buttonForText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button for ${text}`);
  }
  return button;
}

function renderDesktopApp(): void {
  render(
    <StoreProvider value={createStore()}>
      <App />
    </StoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete window.vm0DesktopAuth;
  delete window.vm0DesktopComputerUse;
  vi.clearAllMocks();
});

describe("Desktop renderer bridge integration", () => {
  it("shows a Desktop bridge fallback when preload did not expose the computer use bridge", async () => {
    renderDesktopApp();

    expect(await screen.findByText("Desktop bridge unavailable.")).toBeTruthy();
  });

  it("loads ready runtime state from the desktop bridges and starts computer use", async () => {
    const { auth, computerUse } = installDesktopBridges();
    renderDesktopApp();

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(screen.getByText("desktop@example.com - Desktop Team")).toBeTruthy();
    expect(await screen.findByText("Permissions ready")).toBeTruthy();
    expect(await screen.findByText("Offline")).toBeTruthy();

    fireEvent.click(buttonForText("Start"));

    await waitFor(() => {
      expect(computerUse.start).toHaveBeenCalledWith({
        userInitiated: true,
      });
    });
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(auth.getState).toHaveBeenCalled();
    expect(computerUse.getState).toHaveBeenCalled();
  });

  it("refreshes the runtime panel when the bridge subscription emits", async () => {
    const { computerUse } = installDesktopBridges();
    renderDesktopApp();

    expect(await screen.findByText("Offline")).toBeTruthy();

    computerUse.emitState(createComputerUseState({ status: "online" }));

    expect(await screen.findByText("Online")).toBeTruthy();
    expect(computerUse.subscribe).toHaveBeenCalled();
  });

  it("delegates signed-out account actions to the auth bridge", async () => {
    const { auth } = installDesktopBridges({
      authState: signedOutAuthState,
    });
    renderDesktopApp();

    expect(await screen.findByText("Sign in to Zero")).toBeTruthy();

    fireEvent.click(buttonForText("Sign in"));

    await waitFor(() => {
      expect(auth.openSignIn).toHaveBeenCalledTimes(1);
    });
  });
});
