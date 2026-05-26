import { command, computed, state } from "ccstate";
import type {
  DesktopAuthApi,
  DesktopAuthState,
  DesktopComputerUseApi,
} from "../desktop-bridge";
import {
  hasRequiredComputerUsePermissions,
  type DesktopComputerUseState,
} from "../computer-use-types";

const reloadComputerUseState$ = state(0);
const reloadDesktopAuthState$ = state(0);
const autoStartAttempted$ = state(false);

function desktopComputerUseApi(): DesktopComputerUseApi {
  const api = window.vm0DesktopComputerUse;
  if (!api) {
    throw new Error("Desktop Computer Use bridge is unavailable");
  }
  return api;
}

function desktopAuthApi(): DesktopAuthApi {
  const api = window.vm0DesktopAuth;
  if (!api) {
    throw new Error("Desktop auth bridge is unavailable");
  }
  return api;
}

export function hasDesktopComputerUseBridge(): boolean {
  return Boolean(window.vm0DesktopComputerUse);
}

export function hasDesktopAuthBridge(): boolean {
  return Boolean(window.vm0DesktopAuth);
}

export function shouldAutoStartComputerUse(
  stateValue: DesktopComputerUseState,
): boolean {
  return (
    stateValue.supported &&
    hasRequiredComputerUsePermissions(stateValue.permissions) &&
    (stateValue.host.status === "idle" ||
      stateValue.host.status === "unauthenticated")
  );
}

export const computerUseData$ = computed(
  (get): Promise<DesktopComputerUseState> => {
    get(reloadComputerUseState$);
    return desktopComputerUseApi().getState();
  },
);

export const desktopAuthData$ = computed((get): Promise<DesktopAuthState> => {
  get(reloadDesktopAuthState$);
  return desktopAuthApi().getState();
});

const reloadComputerUse$ = command(({ set }) => {
  set(reloadComputerUseState$, (count) => {
    return count + 1;
  });
});

export const refreshComputerUse$ = command(async ({ set }) => {
  await desktopComputerUseApi().refreshPermissions();
  set(reloadComputerUse$);
});

const refreshDesktopAuth$ = command(({ set }) => {
  set(reloadDesktopAuthState$, (count) => {
    return count + 1;
  });
});

export const setupComputerUseBridge$ = command(
  ({ set }, signal: AbortSignal) => {
    const unsubscribeComputerUse = desktopComputerUseApi().subscribe(() => {
      set(reloadComputerUse$);
    });
    const unsubscribeAuth = window.vm0DesktopAuth?.subscribe(() => {
      set(autoStartAttempted$, false);
      set(refreshDesktopAuth$);
      set(reloadComputerUse$);
    });

    signal.addEventListener(
      "abort",
      () => {
        unsubscribeComputerUse();
        unsubscribeAuth?.();
      },
      { once: true },
    );
    set(refreshDesktopAuth$);
    set(refreshComputerUse$);
  },
);

export const startComputerUse$ = command(async ({ set }) => {
  await desktopComputerUseApi().start();
  set(reloadComputerUse$);
});

export const maybeAutoStartComputerUse$ = command(
  async ({ get, set }, stateValue: DesktopComputerUseState) => {
    if (get(autoStartAttempted$) || !shouldAutoStartComputerUse(stateValue)) {
      return;
    }
    set(autoStartAttempted$, true);
    await desktopComputerUseApi().start();
    set(reloadComputerUse$);
  },
);

export const requestAccessibilityPermission$ = command(async ({ set }) => {
  await desktopComputerUseApi().requestAccessibilityPermission();
  set(reloadComputerUse$);
});

export const requestScreenRecordingPermission$ = command(async ({ set }) => {
  await desktopComputerUseApi().requestScreenRecordingPermission();
  set(reloadComputerUse$);
});

export const openAccessibilitySettings$ = command(async () => {
  await desktopComputerUseApi().openAccessibilitySettings();
});

export const openScreenRecordingSettings$ = command(async () => {
  await desktopComputerUseApi().openScreenRecordingSettings();
});

export const openDesktopSignIn$ = command(async () => {
  await desktopAuthApi().openSignIn();
});

export const openDesktopOrgSelection$ = command(async ({ set }) => {
  await desktopAuthApi().openOrgSelection();
  set(autoStartAttempted$, false);
  set(refreshDesktopAuth$);
  set(reloadComputerUse$);
});
