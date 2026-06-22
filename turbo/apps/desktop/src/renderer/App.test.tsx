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
  DesktopDeveloperToolsApi,
  DesktopDeveloperToolsState,
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

const defaultDeveloperToolsState: DesktopDeveloperToolsState = {
  available: false,
  enabled: false,
};

function createComputerUseState({
  deviceName = "lisa",
  keepAwake = { active: false, enabled: false },
  permissions = { accessibility: true, screenRecording: true },
  status = "offline",
}: {
  readonly deviceName?: string | null;
  readonly keepAwake?: DesktopKeepAwakeState;
  readonly permissions?: ComputerUsePermissionState;
  readonly status?: ComputerUseHostRuntimeStatus;
} = {}): DesktopComputerUseState {
  return {
    featureSwitchKey: COMPUTER_USE_FEATURE_SWITCH_KEY,
    platform: "darwin",
    supported: true,
    deviceName,
    permissions,
    host: {
      status,
      hostId: status === "online" ? "host_test" : null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
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
  readonly probeAutomationPermission: ReturnType<
    typeof vi.fn<DesktopComputerUseApi["probeAutomationPermission"]>
  >;
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
  const probeAutomationPermission = vi.fn<
    DesktopComputerUseApi["probeAutomationPermission"]
  >(async (target) => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: {
        ...currentState.permissions,
        automation: {
          chrome: {
            status: "unknown",
            updatedAt: null,
            reason: null,
          },
          safari: {
            status: "unknown",
            updatedAt: null,
            reason: null,
          },
          [target]: {
            status: "granted",
            updatedAt: "2026-06-22T00:00:00.000Z",
            reason: null,
          },
        },
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
    probeAutomationPermission,
    setKeepAwakeEnabled,
    openAccessibilitySettings: vi.fn<
      DesktopComputerUseApi["openAccessibilitySettings"]
    >(async () => {}),
    openScreenRecordingSettings: vi.fn<
      DesktopComputerUseApi["openScreenRecordingSettings"]
    >(async () => {}),
    openAutomationSettings: vi.fn<
      DesktopComputerUseApi["openAutomationSettings"]
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
    probeAutomationPermission,
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

function createDeveloperToolsBridge(initialState: DesktopDeveloperToolsState): {
  readonly api: DesktopDeveloperToolsApi;
  readonly emitState: (nextState: DesktopDeveloperToolsState) => void;
  readonly getState: ReturnType<
    typeof vi.fn<DesktopDeveloperToolsApi["getState"]>
  >;
  readonly subscribe: ReturnType<
    typeof vi.fn<DesktopDeveloperToolsApi["subscribe"]>
  >;
} {
  let currentState = initialState;
  const subscribers = new Set<() => void>();
  const getState = vi.fn<DesktopDeveloperToolsApi["getState"]>(async () => {
    return currentState;
  });
  const setEnabled = vi.fn<DesktopDeveloperToolsApi["setEnabled"]>(
    async (enabled) => {
      currentState = {
        available: currentState.available,
        enabled: currentState.available && enabled,
      };
      return currentState;
    },
  );
  const subscribe = vi.fn<DesktopDeveloperToolsApi["subscribe"]>((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  const api: DesktopDeveloperToolsApi = {
    getState,
    setEnabled,
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
    subscribe,
  };
}

function installDesktopBridges({
  authState = signedInAuthState,
  computerUseState = createComputerUseState(),
  developerToolsState = defaultDeveloperToolsState,
}: {
  readonly authState?: DesktopAuthState;
  readonly computerUseState?: DesktopComputerUseState;
  readonly developerToolsState?: DesktopDeveloperToolsState;
} = {}): {
  readonly auth: ReturnType<typeof createAuthBridge>;
  readonly computerUse: ReturnType<typeof createComputerUseBridge>;
  readonly developerTools: ReturnType<typeof createDeveloperToolsBridge>;
} {
  const auth = createAuthBridge(authState);
  const computerUse = createComputerUseBridge(computerUseState);
  const developerTools = createDeveloperToolsBridge(developerToolsState);
  window.vm0DesktopAuth = auth.api;
  window.vm0DesktopComputerUse = computerUse.api;
  window.vm0DesktopDeveloperTools = developerTools.api;
  return {
    auth,
    computerUse,
    developerTools,
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
  delete window.vm0DesktopDeveloperTools;
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

    expect(
      await screen.findByText("desktop@example.com · Desktop Team"),
    ).toBeTruthy();
    // Permission status is a quiet dot in the footer (auto-checked, no button).
    expect(
      screen.getByTitle("Accessibility and screen recording granted"),
    ).toBeTruthy();
    expect(await screen.findByText("Offline")).toBeTruthy();
    // The permission status updates automatically; there is no manual refresh.
    expect(screen.queryByText("Refresh")).toBeNull();

    fireEvent.click(buttonForText("Go online"));

    await waitFor(() => {
      expect(computerUse.start).toHaveBeenCalledWith({
        userInitiated: true,
      });
    });
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.queryByText("Browser Automation")).toBeNull();
    // The online hero labels this Mac by its friendly device name.
    expect(await screen.findByText("lisa")).toBeTruthy();
    expect(auth.getState).toHaveBeenCalled();
    expect(computerUse.getState).toHaveBeenCalled();
  });

  it("probes browser automation from an explicit user action", async () => {
    const { computerUse } = installDesktopBridges({
      computerUseState: createComputerUseState({
        permissions: { accessibility: false, screenRecording: true },
      }),
    });
    renderDesktopApp();

    expect(await screen.findByText("Browser Automation")).toBeTruthy();
    expect(
      await screen.findByText(
        "Optional for browser control. Test only the browser you use.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Not tested")).toBeTruthy();
    expect(computerUse.probeAutomationPermission).not.toHaveBeenCalled();

    fireEvent.click(buttonForText("Test Chrome"));

    await waitFor(() => {
      expect(computerUse.probeAutomationPermission).toHaveBeenCalledWith(
        "chrome",
      );
    });
  });

  it("treats browser automation as ready when one browser is approved", async () => {
    installDesktopBridges({
      computerUseState: createComputerUseState({
        permissions: {
          accessibility: false,
          screenRecording: true,
          automation: {
            chrome: {
              status: "granted",
              updatedAt: "2026-06-22T00:00:00.000Z",
              reason: null,
            },
            safari: {
              status: "denied",
              updatedAt: "2026-06-22T00:00:00.000Z",
              reason: "Automation denied",
            },
          },
        },
      }),
    });
    renderDesktopApp();

    expect(
      await screen.findByText(
        "Google Chrome ready. Other browsers can be approved later.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Needs approval")).toBeNull();
    expect(screen.queryByText("Test Safari")).toBeNull();
  });

  it("keeps offline account actions in the overflow menu until it is opened", async () => {
    const { auth } = installDesktopBridges();
    renderDesktopApp();

    expect(await screen.findByText("Offline")).toBeTruthy();
    // Switch workspace / sign out are collapsed into the footer menu.
    expect(screen.queryByText("Sign out")).toBeNull();

    fireEvent.click(screen.getByLabelText("Account actions"));

    expect(await screen.findByText("Switch workspace")).toBeTruthy();
    fireEvent.click(buttonForText("Sign out"));

    await waitFor(() => {
      expect(auth.api.signOut).toHaveBeenCalledTimes(1);
    });
  });

  it("refreshes the runtime panel when the bridge subscription emits", async () => {
    const { computerUse } = installDesktopBridges();
    renderDesktopApp();

    expect(await screen.findByText("Offline")).toBeTruthy();

    computerUse.emitState(createComputerUseState({ status: "online" }));

    expect(await screen.findByText("Online")).toBeTruthy();
    expect(computerUse.subscribe).toHaveBeenCalled();
  });

  it("shows runtime details only after developer tools are enabled", async () => {
    const { developerTools } = installDesktopBridges({
      computerUseState: createComputerUseState({ status: "online" }),
    });
    renderDesktopApp();

    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByText("Command Log")).toBeNull();

    developerTools.emitState({ available: true, enabled: true });

    expect(await screen.findByText("Runtime")).toBeTruthy();
    expect(await screen.findByText("Command Log")).toBeTruthy();
    expect(developerTools.subscribe).toHaveBeenCalled();
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
