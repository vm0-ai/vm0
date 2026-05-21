import { command, computed, state } from "ccstate";

type DesktopComputerUseApi = NonNullable<Window["vm0DesktopComputerUse"]>;
export type DesktopComputerUseState = Awaited<
  ReturnType<DesktopComputerUseApi["getState"]>
>;

const internalReload$ = state(0);

function desktopComputerUseApi(): DesktopComputerUseApi {
  const api = window.vm0DesktopComputerUse;
  if (!api) {
    throw new Error("Zero Desktop Computer Use bridge is unavailable");
  }
  return api;
}

export const desktopComputerUseData$ = computed(
  (get): Promise<DesktopComputerUseState> => {
    get(internalReload$);
    return desktopComputerUseApi().getState();
  },
);

export const setupDesktopComputerUseBridge$ = command(
  ({ set }, signal: AbortSignal) => {
    const unsubscribe = desktopComputerUseApi().subscribe(() => {
      set(internalReload$, (previous) => {
        return previous + 1;
      });
    });
    signal.addEventListener("abort", unsubscribe, { once: true });
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);

export const refreshDesktopComputerUse$ = command(({ set }) => {
  set(internalReload$, (previous) => {
    return previous + 1;
  });
});

export const startDesktopComputerUse$ = command(
  async ({ set }, signal: AbortSignal) => {
    await desktopComputerUseApi().start();
    signal.throwIfAborted();
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);

export const requestDesktopComputerUseAccessibilityPermission$ = command(
  async ({ set }, signal: AbortSignal) => {
    await desktopComputerUseApi().requestAccessibilityPermission();
    signal.throwIfAborted();
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);

export const openDesktopComputerUseAccessibilitySettings$ = command(
  async ({ set }, signal: AbortSignal) => {
    await desktopComputerUseApi().openAccessibilitySettings();
    signal.throwIfAborted();
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);

export const openDesktopComputerUseScreenRecordingSettings$ = command(
  async ({ set }, signal: AbortSignal) => {
    await desktopComputerUseApi().openScreenRecordingSettings();
    signal.throwIfAborted();
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);
